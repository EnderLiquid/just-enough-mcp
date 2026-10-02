import { afterEach, describe, expect, it } from "vitest";
import { createOAuthIdentity } from "../packages/core/src/oauth/broker/identity.js";
import {
  createOAuthProtocolAdapter,
  createOAuthRefreshOperation,
} from "../packages/core/src/oauth/broker/oauth-protocol.js";
import {
  OAuthClientRejectedError,
  OAuthPermanentRefreshError,
  OAuthTemporaryProtocolError,
} from "../packages/core/src/oauth/broker/token-coordinator.js";
import {
  FakeOAuthAuthorizationServer,
  type FakeOAuthAuthorizationServerOptions,
} from "./support/fake-oauth-as.js";

const servers: FakeOAuthAuthorizationServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function startFakeAs(
  options: FakeOAuthAuthorizationServerOptions = {},
): Promise<FakeOAuthAuthorizationServer> {
  const server = await FakeOAuthAuthorizationServer.start(options);
  servers.push(server);
  return server;
}

function makeIdentity(resourceUrl: string) {
  return createOAuthIdentity({
    namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
    resourceUrl,
    profile: "default",
  });
}

const clientInformation = {
  client_id: "fake-client",
  redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
};

describe("OAuth protocol adapter", () => {
  it("通过 PRM 与 AS metadata discovery 返回 authorization server 信息", async () => {
    const as = await startFakeAs({ scopesSupported: ["read", "write", "admin"] });
    const adapter = createOAuthProtocolAdapter();

    const result = await adapter.discover(as.resourceUrl);
    expect(result.authorizationServerUrl).toBe(as.authorizationServerUrl);
    expect(result.authorizationServerMetadata).toMatchObject({
      issuer: as.authorizationServerUrl,
      token_endpoint: as.tokenEndpoint,
      registration_endpoint: as.registrationEndpoint,
    });
    expect(result.resourceMetadata).toMatchObject({
      resource: as.resourceUrl,
      authorization_servers: [as.authorizationServerUrl],
      scopes_supported: ["read", "write", "admin"],
    });
  });

  it("discovery 失败且无法确认结果时归一化为临时协议错误", async () => {
    const as = await startFakeAs();
    as.setProtectedResourceMetadataResponse({ status: 503 });
    as.setAuthorizationServerMetadataResponse({ status: 503 });
    const adapter = createOAuthProtocolAdapter();

    await expect(adapter.discover(as.resourceUrl)).rejects.toBeInstanceOf(
      OAuthTemporaryProtocolError,
    );
  });

  it("DCR 使用 registration endpoint 并转发 client metadata 与 scope", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();

    const registration = await adapter.register({
      authorizationServerUrl: as.authorizationServerUrl,
      clientMetadata: {
        redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
        client_name: "just-enough-mcp",
      },
      scope: "read write",
    });
    expect(registration).toMatchObject({
      client_id: "fake-client",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      client_name: "just-enough-mcp",
    });
    expect(as.registrationRequests).toHaveLength(1);
    expect(as.registrationRequests[0]).toMatchObject({
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      scope: "read write",
    });
  });

  it("DCR 错误按临时协议错误处理，不误判为凭证失败", async () => {
    const as = await startFakeAs();
    as.enqueueRegistrationOutcome({ kind: "oauth-error", error: "invalid_client_metadata" });
    const adapter = createOAuthProtocolAdapter();

    const error = await adapter.register({
      authorizationServerUrl: as.authorizationServerUrl,
      clientMetadata: { redirect_uris: ["http://127.0.0.1:33418/oauth/callback"] },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthTemporaryProtocolError);
  });

  it("refresh 返回 token 并保留服务端未轮转的 refresh token", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();

    const tokens = await adapter.refresh({
      authorizationServerUrl: as.authorizationServerUrl,
      clientInformation,
      refreshToken: "refresh-old",
      resource: new URL(as.resourceUrl),
    });
    expect(tokens).toMatchObject({
      access_token: "access-1",
      token_type: "Bearer",
      expires_in: 3_600,
      refresh_token: "refresh-1",
      scope: "read write",
    });
    expect(as.tokenRequests).toEqual([{
      grantType: "refresh_token",
      refreshToken: "refresh-old",
      clientId: "fake-client",
      resource: as.resourceUrl,
    }]);

    as.enqueueTokenOutcome({ kind: "tokens", accessToken: "access-2", refreshToken: null });
    const rotated = await adapter.refresh({
      authorizationServerUrl: as.authorizationServerUrl,
      clientInformation,
      refreshToken: "refresh-1",
    });
    expect(rotated.refresh_token).toBe("refresh-1");
  });

  it("invalid_grant 与 invalid_scope 归一化为可区分的永久凭证失败", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();

    const cases = [
      { errorCode: "invalid_grant", reason: "invalid-grant" },
      { errorCode: "invalid_scope", reason: "invalid-scope" },
    ] as const;
    for (const { errorCode, reason } of cases) {
      as.enqueueTokenOutcome({ kind: "oauth-error", error: errorCode });
      const failure = adapter.refresh({
        authorizationServerUrl: as.authorizationServerUrl,
        clientInformation,
        refreshToken: "refresh-old",
      });
      await expect(failure).rejects.toBeInstanceOf(OAuthPermanentRefreshError);
      await expect(failure).rejects.toMatchObject({ reason });
    }
  });

  it("invalid_client 与 unauthorized_client 归一化为 client 注册失败", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();

    for (const errorCode of ["invalid_client", "unauthorized_client"]) {
      as.enqueueTokenOutcome({ kind: "oauth-error", error: errorCode });
      await expect(adapter.refresh({
        authorizationServerUrl: as.authorizationServerUrl,
        clientInformation,
        refreshToken: "refresh-old",
      })).rejects.toBeInstanceOf(OAuthClientRejectedError);
    }
  });

  it("5xx、网络错误与 timeout 归一化为临时协议错误", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter({ timeoutMs: 200 });

    as.enqueueTokenOutcome({ kind: "status", status: 503 });
    await expect(adapter.refresh({
      authorizationServerUrl: as.authorizationServerUrl,
      clientInformation,
      refreshToken: "refresh-old",
    })).rejects.toBeInstanceOf(OAuthTemporaryProtocolError);

    as.enqueueTokenOutcome({ kind: "network-error" });
    await expect(adapter.refresh({
      authorizationServerUrl: as.authorizationServerUrl,
      clientInformation,
      refreshToken: "refresh-old",
    })).rejects.toBeInstanceOf(OAuthTemporaryProtocolError);

    as.enqueueTokenOutcome({ kind: "hang" });
    await expect(adapter.refresh({
      authorizationServerUrl: as.authorizationServerUrl,
      clientInformation,
      refreshToken: "refresh-old",
    })).rejects.toBeInstanceOf(OAuthTemporaryProtocolError);
  });
});

describe("OAuth refresh operation", () => {
  it("把 token response 归一化为 credential update，并携带 resource indicator", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();
    const operation = createOAuthRefreshOperation({ adapter, now: () => 1_000 });
    const identity = makeIdentity(as.resourceUrl);

    const update = await operation({
      identity,
      refreshToken: "refresh-old",
      credentialRevision: 1,
      authEpoch: 0,
      registration: {
        strategy: "dcr",
        authorizationServerUrl: as.authorizationServerUrl,
        clientInformation,
      },
    });
    expect(update).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: 1_000 + 3_600_000,
      refreshToken: "refresh-1",
      scope: "read write",
    });
    expect(as.tokenRequests[0]?.resource).toBe(as.resourceUrl);
  });

  it("expires_in 缺失或非法时使用 1 小时 fallback", async () => {
    const as = await startFakeAs();
    const adapter = createOAuthProtocolAdapter();
    const operation = createOAuthRefreshOperation({ adapter, now: () => 5_000 });
    const identity = makeIdentity(as.resourceUrl);

    as.enqueueTokenOutcome({ kind: "tokens", expiresIn: 0, refreshToken: null });
    const update = await operation({
      identity,
      refreshToken: "refresh-old",
      credentialRevision: 1,
      authEpoch: 0,
      registration: {
        strategy: "dcr",
        authorizationServerUrl: as.authorizationServerUrl,
        clientInformation,
      },
    });
    expect(update).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: 5_000 + 3_600_000,
      refreshToken: "refresh-old",
      scope: "read write",
    });
  });

});
