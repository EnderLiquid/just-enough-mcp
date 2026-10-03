import { describe, expect, it, vi } from "vitest";
import type { OAuthBrokerClient } from "../packages/core/src/oauth/broker/client.js";
import { resolveCorePluginConfig } from "../packages/core/src/config/plugin-config.js";
import type { ResolvedServerConfig, ServerDefinition } from "../packages/core/src/modeling/types.js";
import { createMcpServer } from "../packages/core/src/servers/servers/factory.js";
import { HttpPublicServer } from "../packages/core/src/servers/servers/http-public-server.js";
import { HttpTokenServer } from "../packages/core/src/servers/servers/http-token-server.js";
import { StdioPragmaticServer } from "../packages/core/src/servers/servers/stdio-pragmatic-server.js";
import { OauthHttpServer } from "../packages/core/src/servers/servers/oauth-http-server.js";

function makeConfig(definition: ServerDefinition, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  const resolved = resolveCorePluginConfig(
    { servers: { demo: definition } },
    { overviewDirectoryPath: "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews" },
  );
  if (resolved.servers.length !== 1) {
    throw new Error(resolved.warnings[0]?.message ?? "测试 server definition 无法解析。");
  }

  return {
    ...resolved.servers[0]!,
    ...overrides,
  };
}

describe("createMcpServer", () => {

  it("从推断的 stdio 定义创建服务器", () => {
    const server = createMcpServer(makeConfig({ command: "npx" }));

    expect(server).toBeInstanceOf(StdioPragmaticServer);
    expect(server.snapshot()).toEqual({
      name: "demo",
      connectState: "disconnected",
      tools: undefined,
    });
  });

  it("创建无静态认证的公共 HTTP 服务器", () => {
    const server = createMcpServer(makeConfig({ url: "https://example.com/mcp" }));

    expect(server).toBeInstanceOf(HttpPublicServer);
  });

  it.each([
    { url: "https://example.com/mcp", bearerToken: "token-123" },
    { url: "https://example.com/mcp", headers: { "X-API-Key": "secret" } },
  ])("为 %o 创建静态令牌 HTTP 服务器", definition => {
    const server = createMcpServer(makeConfig(definition));

    expect(server).toBeInstanceOf(HttpTokenServer);
  });

  it("为 OAuth HTTP server 注入借用的 broker capability，并提供瞬时 status/logout", async () => {
    const getOAuthStatus = vi.fn()
      .mockResolvedValueOnce({ oauthState: "authorized", credentialRevision: 4 })
      .mockRejectedValueOnce(new Error("broker unavailable"));
    const logoutOAuth = vi.fn().mockResolvedValue({
      applied: true,
      oauthState: "authorization-required",
      credentialRevision: 5,
    });
    const closeBroker = vi.fn();
    const oauthCapability = {
      getOAuthStatus,
      logoutOAuth,
      close: closeBroker,
    } as unknown as OAuthBrokerClient;
    const config = makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      headers: { "X-Tenant": "alpha" },
      oauth: {
        clientMetadataUrl: "https://client.example.test/metadata.json",
        profile: "work",
        scope: "write read",
      },
    });
    const server = createMcpServer(config, {
      oauth: {
        oauthCapability,
        namespaceId: `agent-dir:v1:${"e".repeat(64)}`,
      },
    });

    expect(server).toBeInstanceOf(OauthHttpServer);
    expect(server.snapshot()).toMatchObject({ oauthState: "unknown" });
    await expect(server.status?.()).resolves.toMatchObject({ oauthState: "authorized" });
    expect(getOAuthStatus).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        namespaceId: `agent-dir:v1:${"e".repeat(64)}`,
        resourceUrl: "https://example.com/mcp",
        clientMetadataUrl: "https://client.example.test/metadata.json",
        profile: "work",
        requestHeadersDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      scope: "write read",
    });

    await expect(server.status?.()).resolves.toMatchObject({ oauthState: "unknown" });
    expect(server.snapshot()).toMatchObject({ oauthState: "authorized" });
    if (!server.logout) {
      throw new Error("Expected OAuth server logout support.");
    }
    await expect(server.logout()).resolves.toMatchObject({
      connectState: "disconnected",
      oauthState: "authorization-required",
    });
    expect(logoutOAuth).toHaveBeenCalledWith({
      identity: expect.objectContaining({ profile: "work" }),
      scope: "write read",
    });
    await server.close();
    expect(closeBroker).not.toHaveBeenCalled();
  });

  it("保留显式设置的 legacy transport 为主要依据", () => {
    expect(() => createMcpServer(makeConfig({
      transport: "stdio",
      command: "npx",
      url: "https://example.com/mcp",
    }))).not.toThrow();

    expect(() => createMcpServer(makeConfig({
      transport: "http",
      command: "npx",
      url: "https://example.com/mcp",
    }))).not.toThrow();
  });

  it("transport 分派后验证具体服务器字段", () => {
    expect(() => createMcpServer(makeConfig({ transport: "stdio" }))).toThrow(/demo.*command/);
    expect(() => createMcpServer(makeConfig({ transport: "http" }))).toThrow(/demo.*url/);
    expect(() => createMcpServer(makeConfig({ transport: "websocket" }))).toThrow(/stdio.*http/);
    expect(() => createMcpServer(makeConfig({ command: "npx", url: "https://example.com/mcp" }))).toThrow(/demo.*both command and url/);
    expect(() => createMcpServer(makeConfig({}))).toThrow(/demo.*command or url/);
  });
});
