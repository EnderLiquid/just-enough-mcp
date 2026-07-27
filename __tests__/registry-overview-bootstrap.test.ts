import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mocks.connect;
    listTools = mocks.listTools;
    getServerVersion = mocks.getServerVersion;
    close = mocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    close = mocks.transportClose;
    constructor(_options: unknown) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    close = mocks.transportClose;
    constructor(_url: URL, _options?: unknown) {}
  },
}));

import { createServerRegistry } from "../extensions/servers/registry.js";

function makeConfig(serverOverrides: Partial<ResolvedServerConfig> = {}) {
  return makePluginConfig({
    servers: [makeResolvedServerConfig({
      definition: {
        transport: "stdio",
        command: "npx",
      },
      ...serverOverrides,
    })],
  });
}

describe("createServerRegistry onServerReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: [] });
    mocks.getServerVersion.mockReturnValue({
      name: "demo",
      version: "1.0.0",
      description: "Demo MCP server",
    });
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("首次成功连接时触发服务器信息事件", async () => {
    const onServerReady = vi.fn();
    const registry = createServerRegistry({ onServerReady });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    expect(onServerReady).toHaveBeenCalledWith({
      config: expect.objectContaining({ name: "demo", hasExplicitOverviewConfig: false }),
      description: "Demo MCP server",
    });
  });

  it("onServerReady 抛出异常时不影响连接流程", async () => {
    const registry = createServerRegistry({
      onServerReady: vi.fn().mockImplementation(() => {
        throw new Error("observer failed");
      }),
    });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    const server = await registry.getServerSnapshot("demo");
    expect(server).toEqual({
      name: "demo",
      connectState: "connected",
      tools: [],
      description: "Demo MCP server",
    });
  });
});
