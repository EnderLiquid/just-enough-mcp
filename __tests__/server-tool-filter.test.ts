import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfigLoadResult, ResolvedServerConfig } from "../extensions/modeling/types.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
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

function makeServer(definition: Record<string, unknown>): ResolvedServerConfig {
  return {
    name: "demo",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: {
      name: "demo",
      content: "No overview configured yet.",
      source: "none",
    },
    definition: {
      command: "npx",
      ...definition,
    },
  };
}

function makeConfig(definition: Record<string, unknown>): PluginConfigLoadResult {
  return {
    configPath: "C:/Users/Admin/.pi/agent/just-enough-mcp.json",
    overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
    materialization: {
      artifactRoot: ".pi/mcp",
      summaryItemCount: 3,
      previewFullCharsPerItem: 1600,
      previewTruncateToCharsPerItem: 800,
      hardMaxChars: 40000,
      prettyPrintJson: true,
    },
    tui: {
      renderMode: "minimal",
      expandedModeCollapsedLines: 4,
    },
    servers: [makeServer(definition)],
  };
}

const remoteTools = [
  { name: "search", description: "Search" },
  { name: "read", description: "Read" },
  { name: "write", description: "Write" },
];

describe("server tool filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: remoteTools });
    mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.getServerVersion.mockReturnValue({ name: "demo", version: "1.0.0" });
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("limits the catalog to includeTools when configured", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search", "read"] }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search", "read"]);
    expect(registry.getServerState("demo")?.tools?.map(tool => tool.name)).toEqual(["search", "read"]);
  });

  it("applies excludeTools after includeTools", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      includeTools: ["search", "read"],
      excludeTools: ["read", "write"],
    }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search"]);
  });

  it("rejects direct calls to tools hidden by filters", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ excludeTools: ["write"] }));

    await expect(registry.callTool("demo", "write", {})).rejects.toThrow(/Tool "write" is excluded by configuration/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("keeps a distinct error for unknown remote tools", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search"] }));

    await expect(registry.callTool("demo", "read", {})).rejects.toThrow(/Tool "read" is excluded by configuration/);
    await expect(registry.callTool("demo", "missing", {})).rejects.toThrow(/Tool "missing" is not available/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid tool filter configuration", async () => {
    const registry = createServerRegistry();

    await expect(registry.syncConfig(makeConfig({ includeTools: ["search", ""] }))).rejects.toThrow(/includeTools/);
    await expect(registry.syncConfig(makeConfig({ excludeTools: "write" }))).rejects.toThrow(/excludeTools/);
  });
});
