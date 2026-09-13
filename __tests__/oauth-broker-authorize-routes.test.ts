import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runOAuthBrokerProcess } from "../extensions/oauth/broker/broker-process.js";
import { OAuthBrokerClient } from "../extensions/oauth/broker/client.js";
import { FileOAuthCredentialRepository } from "../extensions/oauth/broker/credential-repository.js";
import { createOAuthIdentity, type OAuthIdentity } from "../extensions/oauth/broker/identity.js";
import { FakeOAuthAuthorizationServer } from "./support/fake-oauth-as.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-authorize-routes");
const namespaceId = `agent-dir:v1:${"f".repeat(64)}`;
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

interface AuthorizeHarness {
  readonly client: OAuthBrokerClient;
  readonly running: Promise<void>;
  readonly port: number;
}

function startBroker(
  rootDir: string,
  port: number,
  options: {
    openedUrls?: string[];
    authorizeTimeoutMs?: number;
    openBrowser?: (url: string) => Promise<void>;
  } = {},
): AuthorizeHarness {
  const running = runOAuthBrokerProcess({
    rootDir,
    namespaceId,
    configuredPort: port,
    presenceTtlMs: 500,
    idleGraceMs: 500,
    lockStaleMs: 2_000,
    lockUpdateMs: 1_000,
    authorizeTimeoutMs: options.authorizeTimeoutMs ?? 5_000,
    openBrowser: options.openBrowser ?? (async url => {
      options.openedUrls?.push(url);
    }),
  });
  const client = new OAuthBrokerClient({
    rootDir,
    namespaceId,
    configuredPort: port,
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 2_000,
    reconnectIntervalMs: 20,
    presencePulseMs: 100,
    authorizeTimeoutMs: 10_000,
  });
  return { client, running, port };
}

function makeIdentity(as: FakeOAuthAuthorizationServer): OAuthIdentity {
  return createOAuthIdentity({
    namespaceId,
    resourceUrl: as.resourceUrl,
    profile: "default",
  });
}

async function readStateParameter(url: string): Promise<string> {
  const state = new URL(url).searchParams.get("state");
  if (!state) {
    throw new Error("Expected the authorization URL to carry a state parameter.");
  }
  return state;
}

async function waitForOpenedUrl(openedUrls: string[]): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const url = openedUrls.at(-1);
    if (url) {
      return url;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error("The broker never opened the authorization URL.");
}

async function triggerCallback(
  port: number,
  query: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?${query}`);
  return { status: response.status, body: await response.text() };
}

describe("OAuth broker authorize routes", () => {
  it("完成 discovery、DCR、浏览器授权与 code exchange", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();

      const pending = client.authorizeOAuth({ identity });
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      expect(new URL(authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
      expect(new URL(authorizationUrl).searchParams.get("resource")).toBe(as.resourceUrl);

      const state = await readStateParameter(authorizationUrl);
      const callback = await triggerCallback(port, `code=test-code&state=${state}`);
      expect(callback.status).toBe(200);
      expect(callback.body).toContain("Authorization complete");

      await expect(pending).resolves.toMatchObject({
        oauthState: "authorized",
        credentialRevision: 1,
        scope: "read write",
      });
      await expect(client.getOAuthStatus({ identity })).resolves.toMatchObject({
        oauthState: "authorized",
        credentialRevision: 1,
      });
      await expect(client.getOAuthToken({ identity })).resolves.toMatchObject({
        credentialRevision: 1,
      });

      expect(as.registrationRequests).toHaveLength(1);
      expect(as.registrationRequests[0]).toMatchObject({
        redirect_uris: [`http://127.0.0.1:${port}/oauth/callback`],
        client_name: "just-enough-mcp",
        token_endpoint_auth_method: "none",
        scope: "read write",
      });
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]).toMatchObject({
        grantType: "authorization_code",
        resource: as.resourceUrl,
      });

      const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const record = await repository.readRecord(identity);
      expect(record.registration).toBeDefined();
      expect(record.discovery).toBeDefined();
      expect(record.authorization.tokens?.refreshToken).toBeDefined();
      expect(record.challengedScopes).toEqual([]);
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("显式 scope 优先于 401 challenge，并并入追加集合", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();

    // 先写入一个追加集合，模拟运行时 403 insufficient_scope 已转发。
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({
      record: { ...record, challengedScopes: ["admin"] },
      result: undefined,
    }));

    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });
    try {
      client.start();
      await client.ensureConnected();

      const pending = client.authorizeOAuth({
        identity,
        scope: "read",
        initialChallengeScope: "write",
      });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("admin read");
      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);
      await expect(pending).resolves.toMatchObject({ oauthState: "authorized" });

      const updated = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const record = await updated.readRecord(identity);
      expect(record.challengedScopes).toEqual([]);
      // fake AS 的 token response 固定回落到 scopes_supported；请求 scope 的语义已在上面的 URL 断言。
      expect(record.authorization.tokens?.scope).toBe("read write");
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("config 缺失时 401 challenge 优先于 scopes_supported", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      const pending = client.authorizeOAuth({ identity, initialChallengeScope: "write" });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("write");
      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);
      await expect(pending).resolves.toMatchObject({ oauthState: "authorized" });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("优先使用 session 转发的 resource metadata URL", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();

      const pending = client.authorizeOAuth({
        identity,
        resourceMetadataUrl: as.protectedResourceMetadataUrl,
      });
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);
      await expect(pending).resolves.toMatchObject({ oauthState: "authorized" });

      expect(as.protectedResourceMetadataRequests).toContain(
        `/.well-known/oauth-protected-resource/mcp`,
      );
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("未知 state 返回 transaction not found 页面", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const port = await allocatePort();
    const { client, running } = startBroker(rootDir, port);

    try {
      client.start();
      await client.ensureConnected();
      const callback = await triggerCallback(port, "code=test-code&state=missing");
      expect(callback.status).toBe(400);
      expect(callback.body).toContain("Authorization transaction not found");
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("并发 authorize 共享同一浏览器事务与 code exchange", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      const first = client.authorizeOAuth({ identity });
      const second = client.authorizeOAuth({ identity });
      void first.catch(() => undefined);
      void second.catch(() => undefined);

      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      expect(openedUrls).toHaveLength(1);

      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).toMatchObject({ oauthState: "authorized", credentialRevision: 1 });
      expect(as.registrationRequests).toHaveLength(1);
      expect(as.tokenRequests).toHaveLength(1);
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("caller 取消只结束自己的等待，不影响共享事务", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      const controller = new AbortController();
      const cancelled = client.authorizeOAuth({ identity }, { signal: controller.signal });
      const waiting = client.authorizeOAuth({ identity });
      void cancelled.catch(() => undefined);
      void waiting.catch(() => undefined);

      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "broker-request-aborted" });

      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);
      await expect(waiting).resolves.toMatchObject({
        oauthState: "authorized",
        credentialRevision: 1,
      });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("浏览器打开失败返回 browser-open-failed", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const { client, running } = startBroker(rootDir, port, {
      openBrowser: async () => {
        throw new Error("no browser");
      },
    });

    try {
      client.start();
      await client.ensureConnected();
      await expect(client.authorizeOAuth({ identity })).rejects.toMatchObject({
        remoteCode: "browser-open-failed",
        status: 500,
      });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("code exchange 的 invalid_grant 返回 authorization-code-rejected 且不写 credential", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      as.enqueueTokenOutcome({ kind: "oauth-error", error: "invalid_grant" });

      const pending = client.authorizeOAuth({ identity });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      const state = await readStateParameter(authorizationUrl);
      const callback = await triggerCallback(port, `code=bad-code&state=${state}`);
      expect(callback.body).toContain("Authorization failed");

      await expect(pending).rejects.toMatchObject({
        remoteCode: "authorization-code-rejected",
        status: 409,
      });
      await expect(client.getOAuthStatus({ identity })).resolves.toMatchObject({
        oauthState: "authorization-required",
        credentialRevision: 0,
      });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("code exchange 的 invalid_client 返回 authorization-client-rejected 并失效 registration", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      as.enqueueTokenOutcome({ kind: "oauth-error", error: "invalid_client" });

      const pending = client.authorizeOAuth({ identity });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `code=test-code&state=${state}`);

      await expect(pending).rejects.toMatchObject({
        remoteCode: "authorization-client-rejected",
        status: 409,
      });
      const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const record = await repository.readRecord(identity);
      expect(record.registration).toBeUndefined();
      expect(record.discovery).toBeDefined();
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("用户拒绝时返回 authorization-denied，且不写 credential", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      const pending = client.authorizeOAuth({ identity });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      const state = await readStateParameter(authorizationUrl);
      const callback = await triggerCallback(
        port,
        `error=access_denied&error_description=Denied&state=${state}`,
      );
      expect(callback.status).toBe(200);
      expect(callback.body).toContain("Authorization failed");
      await expect(pending).rejects.toMatchObject({
        code: "broker-remote-error",
        remoteCode: "authorization-denied",
        status: 409,
      });

      const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const record = await repository.readRecord(identity);
      expect(record.authorization.tokens).toBeUndefined();
      expect(record.registration).toBeDefined();
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("AS 拒绝 invalid_scope 时清空追加集合但保留 token 与 registration", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();

    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: {
          credentialRevision: 3,
          authEpoch: 1,
          tokens: {
            accessToken: "access-existing",
            accessTokenExpiresAt: 10_000,
            refreshToken: "refresh-existing",
            scope: "read",
          },
        },
        challengedScopes: ["admin"],
      },
      result: undefined,
    }));

    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });
    try {
      client.start();
      await client.ensureConnected();

      const pending = client.authorizeOAuth({ identity });
      void pending.catch(() => undefined);
      const authorizationUrl = await waitForOpenedUrl(openedUrls);
      const state = await readStateParameter(authorizationUrl);
      await triggerCallback(port, `error=invalid_scope&state=${state}`);
      await expect(pending).rejects.toMatchObject({
        remoteCode: "authorization-scope-rejected",
        status: 409,
      });

      const updated = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
      const record = await updated.readRecord(identity);
      expect(record.challengedScopes).toEqual([]);
      expect(record.authorization.tokens?.accessToken).toBe("access-existing");
      expect(record.registration).toBeDefined();
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("拒绝非法 authorize 请求参数", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const { client, running } = startBroker(rootDir, port);

    try {
      client.start();
      await client.ensureConnected();
      await expect(client.authorizeOAuth({
        identity,
        resourceMetadataUrl: "ftp://example.com/prm",
      })).rejects.toMatchObject({ remoteCode: "invalid-request", status: 400 });
      await expect(client.authorizeOAuth({
        identity,
        initialChallengeScope: "",
      })).rejects.toMatchObject({ remoteCode: "invalid-request", status: 400 });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("等待 callback 超时返回 authorization-timeout", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const { client, running } = startBroker(rootDir, port, { authorizeTimeoutMs: 150 });

    try {
      client.start();
      await client.ensureConnected();
      await expect(client.authorizeOAuth({ identity })).rejects.toMatchObject({
        remoteCode: "authorization-timeout",
        status: 504,
      });
      await expect(client.getOAuthStatus({ identity })).resolves.toMatchObject({
        oauthState: "authorization-required",
      });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);

  it("pending 事务期间 status 返回 authorizing，logout 终止事务", async () => {
    const rootDir = tempDirs.create();
    const as = await startFakeAs();
    const identity = makeIdentity(as);
    const port = await allocatePort();
    const openedUrls: string[] = [];
    const { client, running } = startBroker(rootDir, port, { openedUrls });

    try {
      client.start();
      await client.ensureConnected();
      const pending = client.authorizeOAuth({ identity });
      void pending.catch(() => undefined);
      await waitForOpenedUrl(openedUrls);

      await expect(client.getOAuthStatus({ identity })).resolves.toMatchObject({
        oauthState: "authorizing",
      });
      await client.logoutOAuth({ identity });
      await expect(pending).rejects.toMatchObject({
        remoteCode: "authorization-superseded",
        status: 409,
      });
    } finally {
      await client.close();
      await running;
    }
  }, 15_000);
});
