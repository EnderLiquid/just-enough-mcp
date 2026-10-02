import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runOAuthBrokerProcess } from "../packages/core/src/oauth/broker/broker-process.js";
import { OAuthBrokerClient } from "../packages/core/src/oauth/broker/client.js";
import { FileOAuthCredentialRepository } from "../packages/core/src/oauth/broker/credential-repository.js";
import { createOAuthCredentialState } from "../packages/core/src/oauth/broker/credential-state.js";
import { createOAuthIdentity, type OAuthIdentity } from "../packages/core/src/oauth/broker/identity.js";
import { FakeOAuthAuthorizationServer } from "./support/fake-oauth-as.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-refresh-routes");
const namespaceId = `agent-dir:v1:${"e".repeat(64)}`;
const fakeServers: FakeOAuthAuthorizationServer[] = [];

afterEach(async () => {
  await Promise.all(fakeServers.splice(0).map(server => server.close()));
  tempDirs.cleanup();
});

async function startFakeAs(): Promise<FakeOAuthAuthorizationServer> {
  const server = await FakeOAuthAuthorizationServer.start();
  fakeServers.push(server);
  return server;
}

async function seedAuthorizedRecord(
  rootDir: string,
  as: FakeOAuthAuthorizationServer,
  identity: OAuthIdentity,
  options: { challengedScopes?: readonly string[] } = {},
): Promise<void> {
  const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
  await repository.mutateRecord(identity, record => ({
    record: {
      ...record,
      authorization: createOAuthCredentialState({
        credentialRevision: 5,
        authEpoch: 2,
        tokens: {
          accessToken: "access-seed",
          accessTokenExpiresAt: 0,
          refreshToken: "refresh-seed",
          scope: "read write",
        },
      }),
      registration: {
        strategy: "dcr",
        authorizationServerUrl: as.authorizationServerUrl,
        clientInformation: {
          client_id: "fake-client",
          redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
        },
      },
      challengedScopes: options.challengedScopes ?? [],
    },
    result: undefined,
  }));
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  if (!port) {
    throw new Error("Expected the OS to allocate a loopback port.");
  }
  return port;
}

function createClient(rootDir: string, port: number): OAuthBrokerClient {
  return new OAuthBrokerClient({
    rootDir,
    namespaceId,
    configuredPort: port,
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 2_000,
    reconnectIntervalMs: 20,
    presencePulseMs: 100,
  });
}

describe("OAuth broker refresh routes", () => {
  it("通过真实 discovery 与 refresh 轮转 token", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = createOAuthIdentity({
      namespaceId,
      resourceUrl: as.resourceUrl,
      profile: "default",
    });
    await seedAuthorizedRecord(rootDir, as, identity);
    const port = await allocatePort();
    const running = runOAuthBrokerProcess({
      rootDir,
      namespaceId,
      configuredPort: port,
      presenceTtlMs: 500,
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
    });
    const client = createClient(rootDir, port);

    try {
      client.start();
      await client.ensureConnected();

      const first = await client.getOAuthToken({
        identity,
        scope: "read",
        minRemainingMs: 0,
      });
      expect(first).toMatchObject({ accessToken: "access-1", credentialRevision: 6 });
      expect(first.accessTokenExpiresAt).toBeGreaterThan(Date.now());
      expect(as.tokenRequests).toEqual([{
        grantType: "refresh_token",
        refreshToken: "refresh-seed",
        clientId: "fake-client",
        resource: as.resourceUrl,
      }]);

      const second = await client.getOAuthToken({
        identity,
        scope: "read",
        rejectedCredentialRevision: first.credentialRevision,
      });
      expect(second).toMatchObject({ accessToken: "access-2", credentialRevision: 7 });
      expect(as.tokenRequests[1]).toMatchObject({ refreshToken: "refresh-1" });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("并发 token acquisition 只向 token endpoint 发起一次 refresh", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = createOAuthIdentity({
      namespaceId,
      resourceUrl: as.resourceUrl,
      profile: "default",
    });
    await seedAuthorizedRecord(rootDir, as, identity);
    const port = await allocatePort();
    const running = runOAuthBrokerProcess({
      rootDir,
      namespaceId,
      configuredPort: port,
      presenceTtlMs: 500,
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
    });
    const client = createClient(rootDir, port);

    try {
      client.start();
      await client.ensureConnected();

      const [first, second] = await Promise.all([
        client.getOAuthToken({ identity, rejectedCredentialRevision: 5 }),
        client.getOAuthToken({ identity, rejectedCredentialRevision: 5 }),
      ]);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ accessToken: "access-1", credentialRevision: 6 });
      expect(as.tokenRequests).toHaveLength(1);
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("临时失败保留 token，永久失败按类别清理", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const grantIdentity = createOAuthIdentity({
      namespaceId,
      resourceUrl: `${as.resourceUrl}?profile=grant`,
      profile: "grant",
    });
    const clientIdentity = createOAuthIdentity({
      namespaceId,
      resourceUrl: `${as.resourceUrl}?profile=client`,
      profile: "client",
    });
    await seedAuthorizedRecord(rootDir, as, grantIdentity);
    await seedAuthorizedRecord(rootDir, as, clientIdentity, { challengedScopes: ["admin"] });
    const port = await allocatePort();
    const running = runOAuthBrokerProcess({
      rootDir,
      namespaceId,
      configuredPort: port,
      presenceTtlMs: 500,
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
    });
    const client = createClient(rootDir, port);

    try {
      client.start();
      await client.ensureConnected();

      as.enqueueTokenOutcome({ kind: "status", status: 503 });
      await expect(client.getOAuthToken({ identity: grantIdentity })).rejects.toMatchObject({
        status: 503,
        remoteCode: "temporary-protocol-error",
      });
      await expect(client.getOAuthToken({ identity: grantIdentity })).resolves.toMatchObject({
        accessToken: "access-1",
        credentialRevision: 6,
      });

      as.enqueueTokenOutcome({ kind: "oauth-error", error: "invalid_grant" });
      await expect(client.getOAuthToken({
        identity: grantIdentity,
        rejectedCredentialRevision: 6,
      })).rejects.toMatchObject({
        status: 409,
        remoteCode: "authorization-required",
      });
      await expect(client.getOAuthStatus({ identity: grantIdentity })).resolves.toMatchObject({
        oauthState: "authorization-required",
      });

      as.enqueueTokenOutcome({ kind: "oauth-error", error: "invalid_client" });
      await expect(client.getOAuthToken({
        identity: clientIdentity,
        rejectedCredentialRevision: 5,
      })).rejects.toMatchObject({
        status: 409,
        remoteCode: "authorization-required",
      });

      const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const grantRecord = await repository.readRecord(grantIdentity);
      expect(grantRecord.authorization.tokens).toBeUndefined();
      expect(grantRecord.registration).toBeDefined();
      expect(grantRecord.discovery).toBeDefined();

      const clientRecord = await repository.readRecord(clientIdentity);
      expect(clientRecord.authorization.tokens).toBeUndefined();
      expect(clientRecord.registration).toBeUndefined();
      expect(clientRecord.challengedScopes).toEqual([]);
      expect(clientRecord.discovery).toBeDefined();
    } finally {
      await client.close();
      await running;
    }
  }, 20_000);

  it("broker 重启后恢复 registration/discovery 并继续轮转 refresh token", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = createOAuthIdentity({
      namespaceId,
      resourceUrl: as.resourceUrl,
      profile: "default",
    });
    await seedAuthorizedRecord(rootDir, as, identity);
    const port = await allocatePort();
    const options = {
      rootDir,
      namespaceId,
      configuredPort: port,
      presenceTtlMs: 500,
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
    };

    const firstRun = runOAuthBrokerProcess(options);
    const firstClient = createClient(rootDir, port);
    try {
      firstClient.start();
      await firstClient.ensureConnected();
      await expect(firstClient.getOAuthToken({ identity })).resolves.toMatchObject({
        accessToken: "access-1",
        credentialRevision: 6,
      });
    } finally {
      await firstClient.close();
      await firstRun;
    }

    const secondRun = runOAuthBrokerProcess(options);
    const secondClient = createClient(rootDir, port);
    try {
      secondClient.start();
      await secondClient.ensureConnected();

      await expect(secondClient.getOAuthToken({ identity })).resolves.toMatchObject({
        accessToken: "access-1",
        credentialRevision: 6,
      });
      expect(as.tokenRequests).toHaveLength(1);

      await expect(secondClient.getOAuthToken({
        identity,
        rejectedCredentialRevision: 6,
      })).resolves.toMatchObject({
        accessToken: "access-2",
        credentialRevision: 7,
      });
      expect(as.tokenRequests[1]).toMatchObject({ refreshToken: "refresh-1" });
    } finally {
      await secondClient.close();
      await secondRun;
    }
  }, 20_000);
});
