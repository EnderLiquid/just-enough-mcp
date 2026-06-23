import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeServerState } from "../extensions/modeling/types.js";

const mocks = vi.hoisted(() => ({
  getMcpRuntime: vi.fn(),
  materializeToolCallResult: vi.fn(),
}));

vi.mock("../extensions/clients/runtime.js", () => ({
  getMcpRuntime: mocks.getMcpRuntime,
}));

vi.mock("../extensions/artifacts/materializer.js", () => ({
  materializeToolCallResult: mocks.materializeToolCallResult,
}));

import { mcpTool } from "../extensions/tools/mcp-tool.js";

function makeServerState(overrides: Partial<RuntimeServerState> = {}): RuntimeServerState {
  return {
    config: {
      name: "demo",
      transport: "stdio",
      command: "npx",
      connectionMode: "lazy",
      overview: {
        name: "demo",
        content: "demo overview",
        transport: "stdio",
        source: "none",
      },
    },
    status: "connected",
    ...overrides,
  };
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
    const connectServer = vi.fn().mockResolvedValue(makeServerState({
      status: "error",
      error: "dial tcp timeout",
    }));

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
      "Failed to connect MCP server: demo\ndial tcp timeout",
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

  it("preserves downstream MCP business failures as materialized error results", async () => {
    const refreshFooter = vi.fn();
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerState(),
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
        resultPresentation: {
          artifactRoot: ".pi/mcp",
          summaryItemCount: 3,
          previewLinesPerItem: 3,
          previewCharsPerItem: 200,
          hardMaxChars: 40000,
          collapsedPreviewLines: 4,
          prettyPrintJson: true,
        },
      }),
      sync: vi.fn(),
      closeAll: vi.fn(),
    });

    mocks.materializeToolCallResult.mockReturnValue({
      callDir: "D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1",
      manifestPath: "D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1/manifest.json",
      payloadItems: [],
      payloadItemIndexes: [],
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
    expect(result.details).toBeUndefined();
  });
});
