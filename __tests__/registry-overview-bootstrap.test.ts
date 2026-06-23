import { describe, expect, it, beforeEach, vi } from "vitest";
import type { PluginConfigLoadResult, ResolvedServerConfig } from "../extensions/modeling/types.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  bootstrap: vi.fn(),
  transportClose: vi.fn(),
  notifyInfo: vi.fn(),
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

vi.mock("../extensions/config/overview-bootstrap.js", () => ({
  tryBootstrapOverviewFromDescription: mocks.bootstrap,
}));

vi.mock("../extensions/ui/notifier.js", () => ({
  notifyInfo: mocks.notifyInfo,
}));

import { createClientRegistry } from "../extensions/clients/registry.js";

function makeServer(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "demo",
    transport: "stdio",
    command: "npx",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: {
      name: "demo",
      content: "No overview configured yet.",
      transport: "stdio",
      source: "none",
    },
    ...overrides,
  } as ResolvedServerConfig;
}

function makeConfig(serverOverrides: Partial<ResolvedServerConfig> = {}): PluginConfigLoadResult {
  return {
    configPath: "C:/Users/Admin/.pi/agent/just-enough-mcp.json",
    overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
    resultPresentation: {
      artifactRoot: ".pi/mcp",
      summaryItemCount: 3,
      previewLinesPerItem: 12,
      previewCharsPerItem: 800,
      hardMaxChars: 40000,
      prettyPrintJson: true,
      collapsedPreviewLines: 4,
    },
    servers: [makeServer(serverOverrides)],
  };
}

describe("createClientRegistry overview bootstrap", () => {
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

  it("creates overview stub on first successful connection", async () => {
    const registry = createClientRegistry();
    mocks.bootstrap.mockReturnValue({
      created: true,
      path: "C:/Users/Admin/.pi/agent/mcp-overviews/demo.md",
    });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    expect(mocks.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ name: "demo", hasExplicitOverviewConfig: false }),
      "C:/Users/Admin/.pi/agent/mcp-overviews",
      "Demo MCP server",
    );
    expect(mocks.notifyInfo).toHaveBeenCalledWith("Created MCP overview stub: demo");
  });

  it("does not fail the connection flow when overview bootstrap throws", async () => {
    const registry = createClientRegistry();
    mocks.bootstrap.mockImplementation(() => {
      throw new Error("disk full");
    });

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    const server = registry.getServerState("demo");
    expect(server?.status).toBe("connected");
    expect(server?.tools).toEqual([]);
  });
});
