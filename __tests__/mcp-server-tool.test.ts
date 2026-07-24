import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpRuntime } from "../extensions/servers/runtime.js";
import type { ServerRegistry } from "../extensions/servers/registry.js";
import { makeServerSnapshot } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  getMcpRuntime: vi.fn(),
}));

vi.mock("../extensions/servers/runtime.js", () => ({
  getMcpRuntime: mocks.getMcpRuntime,
}));

import {
  mcpServerTool,
  registerMcpServerTool,
} from "../extensions/tools/mcp-server-tool.js";

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
    connectServer: async () => { throw new Error("Unexpected connectServer call."); },
    disconnectServer: async () => { throw new Error("Unexpected disconnectServer call."); },
    getServerCatalog: async () => { throw new Error("Unexpected getServerCatalog call."); },
    callTool: async () => { throw new Error("Unexpected callTool call."); },
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

function executeMcpServer(
  params: Parameters<typeof mcpServerTool.execute>[1],
  signal?: AbortSignal,
) {
  return mcpServerTool.execute("tool-call", params, signal, vi.fn(), {} as Parameters<typeof mcpServerTool.execute>[4]);
}

describe("mcpServerTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects action-specific invalid field combinations", async () => {
    useRuntime();

    await expect(executeMcpServer({ action: "list", server: "demo" })).rejects.toThrow(
      'action "list" does not accept server',
    );
    await expect(executeMcpServer({ action: "connect" })).rejects.toThrow(
      'action "connect" requires a non-empty server',
    );
    await expect(executeMcpServer({ action: "disconnect", server: " " })).rejects.toThrow(
      'action "disconnect" requires a non-empty server',
    );
    await expect(executeMcpServer({
      action: "list",
      extra: true,
    } as unknown as Parameters<typeof mcpServerTool.execute>[1])).rejects.toThrow("unknown field extra");
  });

  it("lists server states with pluralization", async () => {
    const refreshFooter = vi.fn();
    const status = {
      connectedCount: 1,
      totalCount: 2,
      servers: [
        makeServerSnapshot({ name: "context7", connectState: "connected" }),
        makeServerSnapshot({ name: "tavily", connectState: "disconnected" }),
      ],
    };
    useRuntime({ getStatus: () => status, refreshFooter });

    const result = await executeMcpServer({ action: "list" });

    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "1/2 servers connected:\n\n[1] context7\nconnected\n\n[2] tavily\ndisconnected",
    });
    expect(result.details).toEqual({ kind: "list", connectedCount: 1, totalCount: 2 });
  });

  it("uses singular server in a one-entry list", async () => {
    useRuntime({
      getStatus: () => ({
        connectedCount: 1,
        totalCount: 1,
        servers: [makeServerSnapshot()],
      }),
    });

    const result = await executeMcpServer({ action: "list" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1/1 server connected:"),
    });
  });

  it("connects explicitly and forwards AbortSignal", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockResolvedValue(makeServerSnapshot());
    useRuntime({ refreshFooter, registry: { connectServer } });

    const result = await executeMcpServer({ action: "connect", server: "demo" }, signal);

    expect(connectServer).toHaveBeenCalledWith("demo", signal);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Connected" });
    expect(result.details).toEqual({ kind: "connect" });
  });

  it("refreshes the footer after a failed connect", async () => {
    const error = new Error("dial tcp timeout");
    const refreshFooter = vi.fn();
    useRuntime({
      refreshFooter,
      registry: { connectServer: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpServer({ action: "connect", server: "demo" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("disconnects explicitly without treating AbortSignal as close cancellation", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const disconnectServer = vi.fn().mockResolvedValue(makeServerSnapshot({ connectState: "disconnected" }));
    useRuntime({ refreshFooter, registry: { disconnectServer } });

    const result = await executeMcpServer({ action: "disconnect", server: "demo" }, signal);

    expect(disconnectServer).toHaveBeenCalledWith("demo");
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Disconnected" });
    expect(result.details).toEqual({ kind: "disconnect" });
  });

  it("refreshes the footer after a failed disconnect", async () => {
    const error = new Error("Unknown MCP server: missing");
    const refreshFooter = vi.fn();
    useRuntime({
      refreshFooter,
      registry: { disconnectServer: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpServer({ action: "disconnect", server: "missing" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });
});

describe("registerMcpServerTool", () => {
  it("registers mcp_server without a tool_result hook", () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    registerMcpServerTool({ registerTool, on } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledWith(mcpServerTool);
    expect(on).not.toHaveBeenCalled();
  });
});
