import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSnapshot } from "../extensions/modeling/types.js";

const mocks = vi.hoisted(() => ({
  getMcpRuntime: vi.fn(),
  materializeToolCallResult: vi.fn(),
}));

vi.mock("../extensions/servers/runtime.js", () => ({
  getMcpRuntime: mocks.getMcpRuntime,
}));

vi.mock("../extensions/artifacts/materializer.js", () => ({
  materializeToolCallResult: mocks.materializeToolCallResult,
}));

import { mcpTool } from "../extensions/tools/mcp-tool.js";

function makeServerSnapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    name: "demo",
    profile: "stdio-tools-pragmatic",
    connectState: "connected",
    ...overrides,
  } as ServerSnapshot;
}

function makeContext() {
  return {
    cwd: "D:/projects/ts/just-enough-mcp",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
    },
  };
}

describe("mcpTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on failed connect after refreshing the footer", async () => {
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockRejectedValue(new Error("dial tcp timeout"));

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter,
      registry: () => ({
        connectServer,
      }),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();

    await expect(mcpTool.execute("tool-call-1", { connect: "demo" }, undefined, vi.fn(), ctx as never)).rejects.toThrow(
      "dial tcp timeout",
    );

    expect(connectServer).toHaveBeenCalledWith("demo");
    expect(refreshFooter).toHaveBeenCalledWith(ctx);
  });

  it("throws on invalid invocation instead of returning an isError result", async () => {
    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter: vi.fn(),
      registry: () => ({
        connectServer: vi.fn(),
        getServerCatalog: vi.fn(),
        callTool: vi.fn(),
      }),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();

    await expect(mcpTool.execute("tool-call-2", { tool: "search" }, undefined, vi.fn(), ctx as never)).rejects.toThrow(
      "Invalid mcp invocation. Use status, connect, server, or server+tool.",
    );
  });

  it("formats status with a compact summary and numbered server states", async () => {
    const refreshFooter = vi.fn();
    const status = {
      connectedCount: 1,
      totalCount: 2,
      servers: [
        makeServerSnapshot({ name: "context7", connectState: "connected" }),
        makeServerSnapshot({ name: "tavily", connectState: "disconnected" }),
      ],
    };

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn().mockReturnValue(status),
      refreshFooter,
      registry: vi.fn(),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();
    const result = await mcpTool.execute("tool-call-status", {}, undefined, vi.fn(), ctx as never);

    expect(refreshFooter).toHaveBeenCalledWith(ctx);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "1/2 servers connected:\n\n[1] context7\nconnected\n\n[2] tavily\ndisconnected",
    });
    expect(result.details).toEqual({
      kind: "status",
      connectedCount: 1,
      totalCount: 2,
    });
  });

  it("formats successful connect as a terse result", async () => {
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockResolvedValue(makeServerSnapshot({ name: "codegraph" }));

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter,
      registry: () => ({
        connectServer,
      }),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();
    const result = await mcpTool.execute("tool-call-connect", { connect: "codegraph" }, undefined, vi.fn(), ctx as never);

    expect(connectServer).toHaveBeenCalledWith("codegraph");
    expect(refreshFooter).toHaveBeenCalledWith(ctx);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Connected",
    });
    expect(result.details).toEqual({ kind: "connect" });
  });

  it("formats catalog with tool count and numbered JSON entries", async () => {
    const refreshFooter = vi.fn();
    const getServerCatalog = vi.fn().mockResolvedValue({
      server: makeServerSnapshot({ name: "codegraph" }),
      tools: [
        {
          name: "codegraph_search",
          description: "Search symbols",
          inputSchema: { type: "object" },
        },
        {
          name: "codegraph_explore",
          description: "Explore code",
          inputSchema: { type: "object" },
        },
      ],
    });

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter,
      registry: () => ({
        getServerCatalog,
      }),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();
    const result = await mcpTool.execute("tool-call-catalog", { server: "codegraph" }, undefined, vi.fn(), ctx as never);

    expect(getServerCatalog).toHaveBeenCalledWith("codegraph");
    expect(refreshFooter).toHaveBeenCalledWith(ctx);
    expect(result.content[0]).toEqual({
      type: "text",
      text: [
        "2 tools available:",
        "[1] codegraph_search\n{\n  \"name\": \"codegraph_search\",\n  \"description\": \"Search symbols\",\n  \"inputSchema\": {\n    \"type\": \"object\"\n  }\n}",
        "[2] codegraph_explore\n{\n  \"name\": \"codegraph_explore\",\n  \"description\": \"Explore code\",\n  \"inputSchema\": {\n    \"type\": \"object\"\n  }\n}",
      ].join("\n\n"),
    });
    expect(result.details).toEqual({
      kind: "catalog",
      toolCount: 2,
    });
  });

  it("formats one catalog entry with the fixed tools-available summary", async () => {
    const refreshFooter = vi.fn();
    const getServerCatalog = vi.fn().mockResolvedValue({
      server: makeServerSnapshot({ name: "demo" }),
      tools: [{
        name: "only_tool",
        description: "Only tool",
        inputSchema: { type: "object" },
      }],
    });

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter,
      registry: () => ({
        getServerCatalog,
      }),
      config: () => undefined,
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    const ctx = makeContext();
    const result = await mcpTool.execute("tool-call-one-catalog", { server: "demo" }, undefined, vi.fn(), ctx as never);

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 tools available:\n\n[1] only_tool"),
    });
  });

  it("preserves downstream MCP business failures as materialized error results", async () => {
    const refreshFooter = vi.fn();
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      toolName: "search",
      args: { query: "pi" },
      result: {
        content: [{ type: "text", text: "remote tool failed" }],
        isError: true,
      },
    });

    mocks.getMcpRuntime.mockReturnValue({
      getStatus: vi.fn(),
      refreshFooter,
      registry: () => ({
        callTool,
      }),
      config: () => ({
        configPath: "C:/Users/Admin/.pi/agent/just-enough-mcp.json",
        overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
        servers: [],
        materialization: {
          artifactRoot: ".pi/mcp",
          summaryItemCount: 3,
          previewFullCharsPerItem: 400,
          previewTruncateToCharsPerItem: 200,
          hardMaxChars: 40000,
          prettyPrintJson: true,
        },
        tui: {
          renderMode: "minimal",
          expandedModeCollapsedLines: 4,
        },
      }),
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    mocks.materializeToolCallResult.mockReturnValue({
      callDir: "D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1",
      manifestPath: "D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/manifest.json",
      payloadItems: [],
      manifestPayloadItems: [],
      mainFiles: ["D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/01-text.txt"],
      metaFiles: ["D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/manifest.json"],
      summaryText: "remote tool failed\nFull output: D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/01-text.txt",
    });

    const ctx = makeContext();
    const result = await mcpTool.execute(
      "tool-call-3",
      { server: "demo", tool: "search", args: JSON.stringify({ query: "pi" }) },
      undefined,
      vi.fn(),
      ctx as never,
    );

    expect(callTool).toHaveBeenCalledWith("demo", "search", { query: "pi" });
    expect(refreshFooter).toHaveBeenCalledWith(ctx);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "remote tool failed\nFull output: D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/01-text.txt",
    });
    expect(result.details).toEqual({
      kind: "call",
      payloadItemCount: 0,
    });
  });
});
