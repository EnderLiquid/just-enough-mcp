import { describe, expect, it, vi } from "vitest";
import type { OauthCallbackRouter, OauthCallbackWaiter } from "../extensions/oauth/callback-router.js";
import type { OauthCredentialRecord, OauthCredentialStore } from "../extensions/oauth/credential-store.js";
import { OauthAuthorizationRequiredError } from "../extensions/oauth/errors.js";
import { McpOauthClientProvider } from "../extensions/oauth/mcp-oauth-client-provider.js";

function createProviderHarness() {
  let record: OauthCredentialRecord | undefined;
  const waiter: OauthCallbackWaiter = {
    state: "expected-state",
    wait: vi.fn().mockResolvedValue("authorization-code"),
    cancel: vi.fn(),
  };
  const callbackRouter = {
    redirectUrl: "http://127.0.0.1:33418/oauth/callback",
    register: vi.fn().mockResolvedValue(waiter),
  } as unknown as OauthCallbackRouter;
  const credentialStore = {
    read: vi.fn(async () => record),
    saveClientInformation: vi.fn(async (_identity, clientInformation) => {
      record = { serverUrl: "https://example.com/mcp", ...record, clientInformation };
    }),
    saveTokens: vi.fn(async (_identity, tokens) => {
      record = { serverUrl: "https://example.com/mcp", ...record, tokens };
    }),
    clearTokens: vi.fn(async () => {
      if (record) {
        const { tokens: _tokens, ...withoutTokens } = record;
        record = withoutTokens;
      }
    }),
    clearAll: vi.fn(async () => {
      record = undefined;
    }),
  } as unknown as OauthCredentialStore;
  const openAuthorizationUrl = vi.fn().mockResolvedValue(undefined);
  const onCredentialsInvalidated = vi.fn();
  const provider = new McpOauthClientProvider({
    serverName: "demo",
    identity: { serverName: "demo", serverUrl: "https://example.com/mcp" },
    callbackRouter,
    credentialStore,
    openAuthorizationUrl,
    clientMetadataUrl: "https://example.com/clients/just-enough-mcp.json",
    scope: "tools.read",
    onCredentialsInvalidated,
  });

  return {
    provider,
    waiter,
    callbackRouter,
    credentialStore,
    openAuthorizationUrl,
    onCredentialsInvalidated,
    getRecord: () => record,
  };
}

describe("McpOauthClientProvider", () => {
  it("仅在显式 interactive authorization 中允许没有 client registration 的 SDK flow", async () => {
    const { provider } = createProviderHarness();

    await expect(provider.clientInformation()).rejects.toBeInstanceOf(OauthAuthorizationRequiredError);
    await expect(provider.state()).rejects.toBeInstanceOf(OauthAuthorizationRequiredError);
  });

  it("将 callback state、浏览器 URL、PKCE verifier 与本地 credential store 正确衔接", async () => {
    const harness = createProviderHarness();
    const { provider } = harness;
    provider.beginInteractiveAuthorization();

    await expect(provider.state()).resolves.toBe("expected-state");
    await provider.redirectToAuthorization(new URL("https://issuer.example/authorize?state=expected-state"));
    await provider.saveCodeVerifier("pkce-verifier");
    await provider.saveClientInformation({ client_id: "dynamic-client" });
    await provider.saveTokens({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });

    await expect(provider.waitForAuthorizationCode()).resolves.toBe("authorization-code");
    expect(provider.codeVerifier()).toBe("pkce-verifier");
    expect(harness.callbackRouter.register).toHaveBeenCalledTimes(1);
    expect(harness.openAuthorizationUrl).toHaveBeenCalledWith(
      new URL("https://issuer.example/authorize?state=expected-state"),
    );
    expect(harness.getRecord()).toMatchObject({
      clientInformation: { client_id: "dynamic-client" },
      tokens: { access_token: "access-token", refresh_token: "refresh-token" },
    });
    expect(provider.clientMetadata).toEqual({
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      client_name: "just-enough-mcp",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "tools.read",
    });
  });

  it("按 SDK invalidation scope 清理 local record，不在 memory 外保存 verifier", async () => {
    const harness = createProviderHarness();
    const { provider } = harness;
    provider.beginInteractiveAuthorization();
    await provider.saveClientInformation({ client_id: "dynamic-client" });
    await provider.saveTokens({ access_token: "access-token", token_type: "Bearer" });
    await provider.saveCodeVerifier("pkce-verifier");

    await provider.invalidateCredentials("tokens");
    expect(harness.credentialStore.clearTokens).toHaveBeenCalledTimes(1);
    expect(harness.onCredentialsInvalidated).toHaveBeenCalledTimes(1);
    expect(() => provider.codeVerifier()).not.toThrow();

    await provider.invalidateCredentials("all");
    expect(harness.credentialStore.clearAll).toHaveBeenCalledTimes(1);
    expect(harness.onCredentialsInvalidated).toHaveBeenCalledTimes(2);
  });
});
