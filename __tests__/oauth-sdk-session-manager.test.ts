import { describe, expect, it, beforeEach, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OauthCallbackRouter, OauthCallbackWaiter } from "../extensions/oauth/callback-router.js";
import type { OauthCredentialStore } from "../extensions/oauth/credential-store.js";
import type { OauthSessionServices } from "../extensions/oauth/session-services.js";
import { OauthAuthorizationRequiredError } from "../extensions/oauth/errors.js";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {}
  return {
    auth: vi.fn(),
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    getServerVersion: vi.fn(),
    close: vi.fn(),
    openAuthorizationUrl: vi.fn(),
    MockUnauthorizedError,
  };
});

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mocks.auth,
  UnauthorizedError: mocks.MockUnauthorizedError,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    onclose: (() => void) | undefined;
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    getServerVersion = mocks.getServerVersion;
    close = mocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    constructor(_url: URL, _options?: unknown) {}
    close = vi.fn();
  },
}));

import { OauthSdkSessionManager } from "../extensions/servers/servers/oauth-sdk-session-manager.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createServices(waiter?: OauthCallbackWaiter): OauthSessionServices {
  const defaultWaiter: OauthCallbackWaiter = waiter ?? {
    state: "callback-state",
    wait: vi.fn().mockResolvedValue("authorization-code"),
    cancel: vi.fn(),
  };
  return {
    callbackRouter: {
      redirectUrl: "http://127.0.0.1:33418/oauth/callback",
      register: vi.fn().mockResolvedValue(defaultWaiter),
    } as unknown as OauthCallbackRouter,
    credentialStore: {
      read: vi.fn().mockResolvedValue(undefined),
      saveClientInformation: vi.fn().mockResolvedValue(undefined),
      saveTokens: vi.fn().mockResolvedValue(undefined),
      clearTokens: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as OauthCredentialStore,
    openAuthorizationUrl: mocks.openAuthorizationUrl,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createManager(services = createServices()): OauthSdkSessionManager {
  const config = makeResolvedServerConfig({
    name: "oauth-demo",
    definition: {
      transport: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
    },
  });
  return new OauthSdkSessionManager({
    serverName: config.name,
    config,
    serverUrl: new URL("https://example.com/mcp"),
    services,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({
    tools: [{ name: "search", inputSchema: { type: "object" } }],
  });
  mocks.getServerVersion.mockReturnValue({ name: "demo", version: "1.0.0" });
  mocks.close.mockResolvedValue(undefined);
  mocks.openAuthorizationUrl.mockResolvedValue(undefined);
});

describe("OauthSdkSessionManager", () => {
  it("同步完成 browser authorization、token exchange 和连接初始化", async () => {
    mocks.auth
      .mockImplementationOnce(async (provider: OAuthClientProvider) => {
        await provider.state?.();
        await provider.saveCodeVerifier("pkce-verifier");
        await provider.redirectToAuthorization(new URL("https://issuer.example/authorize"));
        return "REDIRECT";
      })
      .mockImplementationOnce(async (provider: OAuthClientProvider, options: { authorizationCode?: string }) => {
        expect(options.authorizationCode).toBe("authorization-code");
        await provider.saveTokens({ access_token: "access-token", token_type: "Bearer" });
        return "AUTHORIZED";
      });
    const services = createServices();
    const manager = createManager(services);

    await expect(manager.authorize()).resolves.toMatchObject({
      connectState: "connected",
      oauthState: "authorized",
      tools: [{ name: "search" }],
    });

    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.openAuthorizationUrl).toHaveBeenCalledTimes(1);
    expect(services.credentialStore.saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "oauth-demo" }),
      { access_token: "access-token", token_type: "Bearer" },
    );
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("普通 connect 在 SDK 报未授权时不触发 browser flow", async () => {
    mocks.connect.mockRejectedValueOnce(new mocks.MockUnauthorizedError("Unauthorized"));
    const services = createServices();
    const manager = createManager(services);

    await expect(manager.connect()).rejects.toBeInstanceOf(OauthAuthorizationRequiredError);
    expect(manager.snapshot()).toMatchObject({
      connectState: "disconnected",
      oauthState: "authorization-required",
    });
    expect(mocks.openAuthorizationUrl).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("close 会取消正在同步等待 callback 的 authorize，而不等待用户完成浏览器操作", async () => {
    const callback = createDeferred<string>();
    const waiter: OauthCallbackWaiter = {
      state: "callback-state",
      wait: vi.fn(() => callback.promise),
      cancel: vi.fn(() => callback.reject(new Error("OAuth authorization was cancelled."))),
    };
    mocks.auth.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.state?.();
      await provider.redirectToAuthorization(new URL("https://issuer.example/authorize"));
      return "REDIRECT";
    });
    const manager = createManager(createServices(waiter));

    const authorizing = manager.authorize();
    await vi.waitFor(() => expect(mocks.openAuthorizationUrl).toHaveBeenCalledTimes(1));
    await expect(manager.close()).resolves.toMatchObject({ connectState: "disconnected" });
    await expect(authorizing).rejects.toThrow("OAuth authorization was cancelled.");
  });

  it("local logout 会等待正在进行的 authorization 收束后再清除本地 record", async () => {
    const tokenExchange = createDeferred<"AUTHORIZED">();
    mocks.auth
      .mockImplementationOnce(async (provider: OAuthClientProvider) => {
        await provider.state?.();
        await provider.redirectToAuthorization(new URL("https://issuer.example/authorize"));
        return "REDIRECT";
      })
      .mockImplementationOnce(async () => tokenExchange.promise);
    const services = createServices();
    const manager = createManager(services);

    const authorizing = manager.authorize();
    await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalledTimes(2));
    const loggingOut = manager.logout();
    expect(services.credentialStore.clearAll).not.toHaveBeenCalled();

    tokenExchange.resolve("AUTHORIZED");
    await expect(loggingOut).resolves.toMatchObject({ oauthState: "authorization-required" });
    await expect(authorizing).rejects.toThrow("OAuth authorization was cancelled.");
    expect(services.credentialStore.clearAll).toHaveBeenCalledTimes(1);
  });

  it("local logout 关闭 client 并清除当前 OAuth record", async () => {
    const services = createServices();
    const manager = createManager(services);
    await manager.connect();

    await expect(manager.logout()).resolves.toMatchObject({
      connectState: "disconnected",
      oauthState: "authorization-required",
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(services.credentialStore.clearAll).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "oauth-demo" }),
    );
  });
});
