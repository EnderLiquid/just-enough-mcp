import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig, ServerSnapshot } from "../extensions/modeling/types.js";
import { createServerRegistry } from "../extensions/servers/registry.js";
import type { McpServer } from "../extensions/servers/servers/types.js";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  createMcpServer: vi.fn(),
}));

vi.mock("../extensions/servers/servers/factory.js", () => ({
  createMcpServer: mocks.createMcpServer,
}));

function snapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    name: "oauth-demo",
    connectState: "disconnected",
    oauthState: "authorization-required",
    ...overrides,
  };
}

function makeServer(
  config: ResolvedServerConfig,
  overrides: Partial<McpServer> = {},
): McpServer {
  return {
    name: config.name,
    config,
    snapshot: () => snapshot({ name: config.name }),
    connect: async () => snapshot({ name: config.name }),
    getCatalog: async () => ({ server: snapshot({ name: config.name }), tools: [] }),
    callTool: async (toolName, args) => ({
      server: snapshot({ name: config.name }),
      toolName,
      args,
      result: { content: [] },
    }),
    close: async () => snapshot({ name: config.name }),
    ...overrides,
  };
}

describe("ServerRegistry OAuth controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("只按 server name 转发 OAuth control", async () => {
    const config = makeResolvedServerConfig({
      name: "oauth-demo",
      definition: { transport: "http", url: "https://example.com/mcp", auth: "oauth" },
    });
    const authorize = vi.fn().mockResolvedValue(snapshot({ oauthState: "authorized" }));
    const logout = vi.fn().mockResolvedValue(snapshot());
    mocks.createMcpServer.mockImplementation((serverConfig: ResolvedServerConfig) => makeServer(serverConfig, {
      authorize,
      logout,
    }));
    const registry = createServerRegistry([config]);
    const signal = new AbortController().signal;

    await expect(registry.authorizeServer("oauth-demo", signal)).resolves.toMatchObject({
      oauthState: "authorized",
    });
    await expect(registry.logoutServer("oauth-demo")).resolves.toMatchObject({
      oauthState: "authorization-required",
    });

    expect(authorize).toHaveBeenCalledWith(signal);
    expect(logout).toHaveBeenCalledWith();
    expect(mocks.createMcpServer).toHaveBeenCalledWith(config, expect.anything());
  });

  it("拒绝不支持 OAuth control 的服务器", async () => {
    const config = makeResolvedServerConfig({ name: "plain", definition: { command: "npx" } });
    mocks.createMcpServer.mockImplementation((serverConfig: ResolvedServerConfig) => makeServer(serverConfig));
    const registry = createServerRegistry([config]);

    await expect(registry.authorizeServer("plain")).rejects.toThrow(
      'MCP server "plain" does not support OAuth authorization.',
    );
    await expect(registry.logoutServer("plain")).rejects.toThrow(
      'MCP server "plain" does not support OAuth logout.',
    );
  });

  it("不会让同步等待的 authorize 阻塞 closeAll", async () => {
    const config = makeResolvedServerConfig({
      name: "oauth-demo",
      definition: { transport: "http", url: "https://example.com/mcp", auth: "oauth" },
    });
    let resolveAuthorize!: (value: ServerSnapshot) => void;
    const pendingAuthorize = new Promise<ServerSnapshot>(resolve => {
      resolveAuthorize = resolve;
    });
    const authorize = vi.fn(() => pendingAuthorize);
    const close = vi.fn().mockResolvedValue(snapshot());
    mocks.createMcpServer.mockImplementation((serverConfig: ResolvedServerConfig) => makeServer(serverConfig, {
      authorize,
      logout: async () => snapshot(),
      close,
    }));
    const registry = createServerRegistry([config]);

    const authorizing = registry.authorizeServer("oauth-demo");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    await registry.closeAll();

    expect(close).toHaveBeenCalledTimes(1);
    resolveAuthorize(snapshot({ oauthState: "authorized" }));
    await expect(authorizing).resolves.toMatchObject({ oauthState: "authorized" });
  });
});
