import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthBrokerClient, requestOAuthBrokerJson } from "../extensions/oauth/broker/client.js";
import { createOAuthCredentialState } from "../extensions/oauth/broker/credential-state.js";
import { InMemoryOAuthCredentialRepository } from "../extensions/oauth/broker/credential-repository.js";
import { createOAuthIdentity } from "../extensions/oauth/broker/identity.js";
import { runOAuthBrokerProcess } from "../extensions/oauth/broker/broker-process.js";
import { OAUTH_BROKER_ROUTES } from "../extensions/oauth/broker/protocol.js";
import { readOAuthBrokerAccess } from "../extensions/oauth/broker/runtime-files.js";
import type { OAuthRefreshOperation } from "../extensions/oauth/broker/token-coordinator.js";
import { OAuthTemporaryProtocolError } from "../extensions/oauth/broker/token-coordinator.js";
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
    await repository.mutate(identity, () => ({
      state: createOAuthCredentialState({
        credentialRevision: 5,
        authEpoch: 2,
        tokens: {
          accessToken: "access-expired",
          accessTokenExpiresAt: 0,
          refreshToken: "refresh-original",
          scope: "read write",
        },
      }),
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
      // discovery 不可注入，只能用 fetch 短路；否则 broker 会向
      // https://mcp.example.test 发真实请求并等满 protocolTimeoutMs。
      // 返回一份可缓存的 AS metadata，使 discovery 不进入后续 refresh 的路径。
      fetchFn: async (url: string | URL) => {
        const target = String(url);
        if (target.includes("oauth-authorization-server")) {
          return new Response(JSON.stringify({
            issuer: "https://mcp.example.test",
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: "https://mcp.example.test/token",
            response_types_supported: ["code"],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          resource: "https://mcp.example.test/rpc",
          authorization_servers: ["https://mcp.example.test"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
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
