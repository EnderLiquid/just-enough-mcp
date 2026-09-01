import { describe, expect, it } from "vitest";
import type { ResolvedServerConfig, ServerDefinition } from "../extensions/modeling/types.js";
import type { OauthSessionServices } from "../extensions/oauth/session-services.js";
import { createMcpServer as createMcpServerWithOauthServices } from "../extensions/servers/servers/factory.js";
import { HttpOauthServer } from "../extensions/servers/servers/http-oauth-server.js";
import { HttpPublicServer } from "../extensions/servers/servers/http-public-server.js";
import { HttpTokenServer } from "../extensions/servers/servers/http-token-server.js";
import { StdioPragmaticServer } from "../extensions/servers/servers/stdio-pragmatic-server.js";

function makeConfig(definition: ServerDefinition, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "demo",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: {
      name: "demo",
      content: "No overview configured yet.",
      source: "none",
    },
    definition,
    ...overrides,
  };
}

const oauthServices = {} as OauthSessionServices;

function createMcpServer(config: ResolvedServerConfig) {
  return createMcpServerWithOauthServices(config, oauthServices);
}

describe("createMcpServer", () => {
  it("创建 OAuth HTTP 服务器", () => {
    const server = createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
    }));

    expect(server).toBeInstanceOf(HttpOauthServer);
    expect(server.snapshot()).toEqual({
      name: "demo",
      connectState: "disconnected",
      oauthState: "authorization-required",
      tools: undefined,
    });
  });

  it("拒绝 OAuth 与不兼容的 transport 或静态 Authorization 配置", () => {
    expect(() => createMcpServer(makeConfig({
      transport: "stdio",
      command: "npx",
      auth: "oauth",
    }))).toThrow(/requires transport "http"/);
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      bearerToken: "token-123",
    }))).toThrow(/cannot combine auth "oauth" with bearerToken/);
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      headers: { Authorization: "Bearer token-123" },
    }))).toThrow(/headers.Authorization/);
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      oauth: {},
    }))).toThrow(/oauth settings but auth is not "oauth"/);
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      oauth: { clientMetadataUrl: "http://example.com/client.json" },
    }))).toThrow(/must be an HTTPS URL/);
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      oauth: { scope: " " },
    }))).toThrow(/oauth.scope must be a non-empty string/);
  });

  it("保留非 Authorization 静态 HTTP headers 供 OAuth server 使用", () => {
    expect(() => createMcpServer(makeConfig({
      url: "https://example.com/mcp",
      auth: "oauth",
      headers: { "X-Tenant": "demo" },
      oauth: { scope: "tools.read" },
    }))).not.toThrow();
  });

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
