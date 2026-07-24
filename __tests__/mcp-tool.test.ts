import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MaterializedToolCallResult } from "../extensions/artifacts/types.js";
import type { McpRuntime } from "../extensions/servers/runtime.js";
import type { ServerRegistry } from "../extensions/servers/registry.js";
import { makePluginConfig, makeServerSnapshot } from "./support/model-fixtures.js";

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

import { mcpTool, registerMcpTool } from "../extensions/tools/mcp-tool.js";

type RuntimeStubOverrides = Partial<Omit<McpRuntime, "registry">> & {
  registry?: Partial<ServerRegistry>;
};

function useRuntime(overrides: RuntimeStubOverrides = {}): McpRuntime {
  const { registry: registryOverrides, ...runtimeOverrides } = overrides;
  const emptyStatus = { connectedCount: 0, totalCount: 0, servers: [] };
  const registry: ServerRegistry = {
    syncConfig: async () => {},
    getStatus: () => emptyStatus,
    getServerState: () => undefined,
    connectServer: async () => {
      throw new Error("Unexpected connectServer call.");
    },
    getServerCatalog: async () => {
      throw new Error("Unexpected getServerCatalog call.");
    },
    callTool: async () => {
      throw new Error("Unexpected callTool call.");
    },
    closeAll: async () => {},
    ...registryOverrides,
  };
  const runtime: McpRuntime = {
    sync: async () => emptyStatus,
    config: () => undefined,
    getStatus: () => emptyStatus,
    registry: () => registry,
    refreshFooter: vi.fn(),
    closeAll: async () => {},
    ...runtimeOverrides,
  };

  mocks.getMcpRuntime.mockReturnValue(runtime);
  return runtime;
}

function executeMcp(
  params: Parameters<typeof mcpTool.execute>[1],
  signal?: AbortSignal,
) {
  const context = {
    cwd: "D:/projects/ts/just-enough-mcp",
  } as Parameters<typeof mcpTool.execute>[4];

  return mcpTool.execute("tool-call", params, signal, vi.fn(), context);
}

describe("mcpTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on failed connect after refreshing the footer", async () => {
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockRejectedValue(new Error("dial tcp timeout"));
    useRuntime({
      refreshFooter,
      registry: { connectServer },
    });

    const signal = new AbortController().signal;
    await expect(executeMcp({ connect: "demo" }, signal)).rejects.toThrow("dial tcp timeout");

    expect(connectServer).toHaveBeenCalledWith("demo", signal);
    expect(refreshFooter).toHaveBeenCalledWith();
  });

  it("throws on invalid invocation instead of returning an isError result", async () => {
    useRuntime();

    await expect(executeMcp({ tool: "search" })).rejects.toThrow(
      "Invalid mcp invocation. Use status, connect, server, or server+tool.",
    );
  });

  it("propagates cancellation without materializing a result", async () => {
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    const callTool = vi.fn().mockRejectedValue(abortReason);
    useRuntime({ registry: { callTool } });

    controller.abort(abortReason);
    await expect(executeMcp({
      server: "demo",
      tool: "search",
      args: JSON.stringify({ query: "pi" }),
    }, controller.signal)).rejects.toBe(abortReason);

    expect(callTool).toHaveBeenCalledWith(
      "demo",
      "search",
      { query: "pi" },
      controller.signal,
    );
    expect(mocks.materializeToolCallResult).not.toHaveBeenCalled();
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
    useRuntime({
      getStatus: () => status,
      refreshFooter,
    });

    const result = await executeMcp({});

    expect(refreshFooter).toHaveBeenCalledWith();
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

  it("uses singular server in status when total count is one", async () => {
    const status = {
      connectedCount: 1,
      totalCount: 1,
      servers: [makeServerSnapshot({ name: "context7", connectState: "connected" })],
    };
    useRuntime({ getStatus: () => status });

    const result = await executeMcp({});

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1/1 server connected:"),
    });
  });

  it("formats successful connect as a terse result", async () => {
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockResolvedValue(makeServerSnapshot({ name: "codegraph" }));
    useRuntime({
      refreshFooter,
      registry: { connectServer },
    });

    const signal = new AbortController().signal;
    const result = await executeMcp({ connect: "codegraph" }, signal);

    expect(connectServer).toHaveBeenCalledWith("codegraph", signal);
    expect(refreshFooter).toHaveBeenCalledWith();
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
    useRuntime({
      refreshFooter,
      registry: { getServerCatalog },
    });

    const signal = new AbortController().signal;
    const result = await executeMcp({ server: "codegraph" }, signal);

    expect(getServerCatalog).toHaveBeenCalledWith("codegraph", signal);
    expect(refreshFooter).toHaveBeenCalledWith();
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

  it("uses singular tool in a one-entry catalog summary", async () => {
    const getServerCatalog = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      tools: [{
        name: "only_tool",
        description: "Only tool",
        inputSchema: { type: "object" },
      }],
    });
    useRuntime({ registry: { getServerCatalog } });

    const result = await executeMcp({ server: "demo" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 tool available:\n\n[1] only_tool"),
    });
  });

  it("preserves downstream MCP business failures for the tool_result hook", async () => {
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
    useRuntime({
      refreshFooter,
      registry: { callTool },
      config: () => makePluginConfig({
        servers: [],
        materialization: {
          artifactRoot: ".pi/mcp",
          summaryItemCount: 3,
          previewFullCharsPerItem: 400,
          previewTruncateToCharsPerItem: 200,
          hardMaxChars: 40000,
          prettyPrintJson: true,
        },
      }),
    });

    const callDir = "D:/projects/ts/just-enough-mcp/.pi/mcp/20260622-1";
    const payloadPath = `${callDir}/01-text.txt`;
    const manifestPath = `${callDir}/manifest.json`;
    const materialized = {
      callDir,
      manifestPath,
      payloadItems: [{
        index: 1,
        source: "content[0]",
        contentType: "text",
        mimeType: "text/plain",
        path: payloadPath,
        fileName: "01-text.txt",
        text: "remote tool failed",
      }],
      manifestPayloadItems: [{
        index: 1,
        source: "content[0]",
        contentType: "text",
        mimeType: "text/plain",
        path: payloadPath,
        fileName: "01-text.txt",
      }],
      mainFiles: [payloadPath],
      metaFiles: [manifestPath],
      summaryText: `remote tool failed\nFull output: ${payloadPath}`,
      budget: {
        summaryItemCount: 3,
        previewFullCharsPerItem: 400,
        previewTruncateToCharsPerItem: 200,
        hardMaxChars: 40000,
      },
    } satisfies MaterializedToolCallResult;
    mocks.materializeToolCallResult.mockReturnValue(materialized);
    const signal = new AbortController().signal;

    const result = await executeMcp({
      server: "demo",
      tool: "search",
      args: JSON.stringify({ query: "pi" }),
    }, signal);

    expect(callTool).toHaveBeenCalledWith("demo", "search", { query: "pi" }, signal);
    expect(refreshFooter).toHaveBeenCalledWith();
    expect(result).not.toHaveProperty("isError");
    expect(result.content[0]).toEqual({
      type: "text",
      text: `remote tool failed\nFull output: ${payloadPath}`,
    });
    expect(result.details).toEqual({
      kind: "call",
      payloadItemCount: 1,
      outcome: "error",
    });
  });
});

describe("registerMcpTool", () => {
  it("promotes failed MCP call outcomes through the Pi tool_result hook", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    registerMcpTool({ registerTool, on } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledWith(mcpTool);
    const registration = on.mock.calls.find(([eventName]) => eventName === "tool_result");
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (event: { toolName: string; details?: unknown }) => unknown;

    expect(handler({
      toolName: "mcp",
      details: { kind: "call", payloadItemCount: 1, outcome: "error" },
    })).toEqual({ isError: true });
    expect(handler({
      toolName: "mcp",
      details: { kind: "call", payloadItemCount: 1, outcome: "success" },
    })).toBeUndefined();
    expect(handler({
      toolName: "other",
      details: { kind: "call", payloadItemCount: 1, outcome: "error" },
    })).toBeUndefined();
  });
});
