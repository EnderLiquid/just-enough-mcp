import { describe, expect, it, beforeEach, vi } from "vitest";
import type { PluginConfigLoadResult, ResolvedServerSpec } from "../extensions/modeling/types.js";

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

import { createServerRegistry } from "../extensions/clients/registry.js";

function makeServer(overrides: Partial<ResolvedServerSpec> = {}): ResolvedServerSpec {
  return {
    name: "demo",
    transport: "stdio",
    command: "npx",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    profile: "stdio-tools-pragmatic",
    overview: {
      name: "demo",
      content: "No overview configured yet.",
      transport: "stdio",
      source: "none",
    },
    ...overrides,
  } as ResolvedServerSpec;
}

function makeConfig(serverOverrides: Partial<ResolvedServerSpec> = {}): PluginConfigLoadResult {
  return {
    configPath: "C:/Users/Admin/.pi/agent/just-enough-mcp.json",
    overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
    resultPresentation: {
      artifactRoot: ".pi/mcp",
      summaryItemCount: 3,
      previewFullCharsPerItem: 1600,
      previewTruncateToCharsPerItem: 800,
      hardMaxChars: 40000,
      prettyPrintJson: true,
      collapsedPreviewLines: 4,
    },
    servers: [makeServer(serverOverrides)],
  };
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

  it("emits observed server facts on first successful connection", async () => {
    const onServerReady = vi.fn();
    const registry = createServerRegistry({ onServerReady });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    expect(onServerReady).toHaveBeenCalledWith({
      spec: expect.objectContaining({ name: "demo", hasExplicitOverviewConfig: false }),
      description: "Demo MCP server",
    });
  });

  it("does not fail the connection flow when onServerReady throws", async () => {
    const registry = createServerRegistry({
      onServerReady: vi.fn().mockImplementation(() => {
        throw new Error("observer failed");
      }),
    });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    const server = registry.getServerState("demo");
    expect(server).toEqual({
      name: "demo",
      profile: "stdio-tools-pragmatic",
      connectState: "connected",
      tools: [],
    });
  });
});
