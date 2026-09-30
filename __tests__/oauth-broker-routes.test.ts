import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthBrokerClient, requestOAuthBrokerJson } from "../src/core/oauth/broker/client.js";
import { createOAuthCredentialState } from "../src/core/oauth/broker/credential-state.js";
import { InMemoryOAuthCredentialRepository } from "../src/core/oauth/broker/credential-repository.js";
import { createOAuthIdentity } from "../src/core/oauth/broker/identity.js";
import { runOAuthBrokerProcess } from "../src/core/oauth/broker/broker-process.js";
import { OAUTH_BROKER_ROUTES } from "../src/core/oauth/broker/protocol.js";
import { readOAuthBrokerAccess } from "../src/core/oauth/broker/runtime-files.js";
import type { OAuthRefreshOperation } from "../src/core/oauth/broker/token-coordinator.js";
import type { OAuthDiscoveryOperation } from "../src/core/oauth/broker/oauth-protocol-types.js";
import { OAuthTemporaryProtocolError } from "../src/core/oauth/broker/token-coordinator.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker-routes");
const namespaceId = `agent-dir:v1:${"b".repeat(64)}`;

afterEach(() => tempDirs.cleanup());

async function allocatePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await closeServer(server);
  if (!port) {
    throw new Error("Expected the OS to allocate a loopback port.");
  }
  return port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe("OAuth broker credential routes", () => {
  it("跨 HTTP 边界校验 presence/namespace，并完成 status、refresh 与条件 logout", async () => {
    const rootDir = tempDirs.create();
    const port = await allocatePort();
    const identity = createOAuthIdentity({
      namespaceId,
      resourceUrl: "https://mcp.example.test/rpc",
      profile: "default",
    });
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: createOAuthCredentialState({
          credentialRevision: 5,
          authEpoch: 2,
          tokens: {
            accessToken: "access-expired",
            accessTokenExpiresAt: 0,
            refreshToken: "refresh-original",
            scope: "read write",
          },
        }),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://mcp.example.test/",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
      },
      result: undefined,
    }));
    const temporaryFailure = new OAuthTemporaryProtocolError("temporary endpoint outage");
    const refresh = vi.fn<OAuthRefreshOperation>()
      .mockRejectedValueOnce(temporaryFailure)
      .mockResolvedValueOnce({
        accessToken: "access-refreshed",
        accessTokenExpiresAt: 9_000,
        refreshToken: "refresh-rotated",
        scope: "write read",
      });
    const discover = vi.fn<OAuthDiscoveryOperation>(async () => ({
      authorizationServerUrl: "https://mcp.example.test",
    }));
    const running = runOAuthBrokerProcess({
      rootDir,
      namespaceId,
      configuredPort: port,
      presenceTtlMs: 500,
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
      credentialRepository: repository,
      refresh,
      discover,
      now: () => 1_000,
    });
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId,
      configuredPort: port,
      requestTimeoutMs: 1_000,
      connectTimeoutMs: 2_000,
      reconnectIntervalMs: 20,
      presencePulseMs: 100,
    });

    try {
      client.start();
      await client.ensureConnected();

      await expect(client.getOAuthStatus({ identity, scope: "read" })).resolves.toEqual({
        oauthState: "authorized",
        credentialRevision: 5,
      });
      await expect(client.getOAuthToken({
        identity,
        scope: "read",
        minRemainingMs: 100,
      })).rejects.toMatchObject({
        code: "broker-remote-error",
        status: 503,
        remoteCode: "temporary-protocol-error",
      });
      expect(await repository.read(identity)).toMatchObject({
        credentialRevision: 5,
        tokens: { refreshToken: "refresh-original" },
      });

      await expect(client.getOAuthToken({
        identity,
        scope: "read",
        minRemainingMs: 100,
      })).resolves.toEqual({
        accessToken: "access-refreshed",
        accessTokenExpiresAt: 9_000,
        credentialRevision: 6,
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(discover).toHaveBeenCalledTimes(1);

      await expect(client.logoutOAuth({
        identity,
        expectedCredentialRevision: 5,
      })).resolves.toEqual({
        applied: false,
        reason: "revision-superseded",
        oauthState: "authorized",
        credentialRevision: 6,
      });

      const wrongNamespaceIdentity = createOAuthIdentity({
        namespaceId: `agent-dir:v1:${"c".repeat(64)}`,
        resourceUrl: identity.resourceUrl,
        profile: identity.profile,
      });
      await expect(client.getOAuthStatus({ identity: wrongNamespaceIdentity })).rejects.toMatchObject({
        code: "broker-remote-error",
        status: 400,
        remoteCode: "identity-namespace-mismatch",
      });

      const access = await readOAuthBrokerAccess(rootDir);
      expect(access).toBeDefined();
      if (!access) {
        throw new Error("Expected OAuth broker access descriptor.");
      }
      await expect(requestOAuthBrokerJson(access, OAUTH_BROKER_ROUTES.oauthStatus, {
        method: "POST",
        params: { identity },
        timeoutMs: 1_000,
      })).rejects.toMatchObject({
        code: "broker-remote-error",
        status: 400,
        remoteCode: "presence-required",
      });

      await expect(client.logoutOAuth({
        identity,
        expectedCredentialRevision: 6,
      })).resolves.toEqual({
        applied: true,
        oauthState: "authorization-required",
        credentialRevision: 7,
      });
      await expect(client.getOAuthToken({
        identity,
        minRemainingMs: 0,
      })).rejects.toMatchObject({
        code: "broker-remote-error",
        status: 409,
        remoteCode: "authorization-required",
      });
      expect(await repository.read(identity)).toEqual(createOAuthCredentialState({
        credentialRevision: 7,
        authEpoch: 3,
      }));
    } finally {
      await client.close();
      await running;
    }
  }, 10_000);
});
