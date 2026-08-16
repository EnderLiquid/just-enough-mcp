import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCurrentServerRegistry } from "../extensions/servers/current-registry.js";
import type { ServerRegistry } from "../extensions/servers/registry.js";
import { makeServerSnapshot } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  refreshFooterStatus: vi.fn(),
}));

vi.mock("../extensions/rendering/footer-status.js", () => ({
  refreshFooterStatus: mocks.refreshFooterStatus,
}));

import {
  mcpServerTool,
  registerMcpServerTool,
} from "../extensions/tools/mcp-server-tool.js";

type RegistryStubOverrides = {
  registry?: Partial<ServerRegistry>;
  refreshFooter?: () => Promise<void>;
};

let disposeRegistry: (() => void) | undefined;

function useRuntime(overrides: RegistryStubOverrides = {}): ServerRegistry {
  const emptyStatus = { connectedCount: 0, totalCount: 0, servers: [] };
  const registry: ServerRegistry = {
    initialize: async () => ({ eagerFailures: [] }),
    getStatus: async () => emptyStatus,
    getServerSnapshot: async () => undefined,
    connectServer: async () => { throw new Error("Unexpected connectServer call."); },
    disconnectServer: async () => { throw new Error("Unexpected disconnectServer call."); },
    getServerCatalog: async () => { throw new Error("Unexpected getServerCatalog call."); },
    callTool: async () => { throw new Error("Unexpected callTool call."); },
    closeAll: async () => {},
    ...overrides.registry,
  };
  disposeRegistry?.();
  disposeRegistry = installCurrentServerRegistry(registry);
  mocks.refreshFooterStatus.mockImplementation(overrides.refreshFooter ?? (async () => {}));
  return registry;
}

function executeMcpServer(
  params: Parameters<typeof mcpServerTool.execute>[1],
  signal?: AbortSignal,
) {
  return mcpServerTool.execute("tool-call", params, signal, vi.fn(), {} as Parameters<typeof mcpServerTool.execute>[4]);
}

afterEach(() => {
  disposeRegistry?.();
  disposeRegistry = undefined;
});

describe("mcpServerTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("插件未初始化时拒绝执行", async () => {
    await expect(executeMcpServer({ action: "status" })).rejects.toThrow(
      "just-enough-mcp is not initialized for the current session",
    );
  });

  it("按 action 类型拒绝无效字段组合", async () => {
    useRuntime();

    await expect(executeMcpServer({ action: "connect" })).rejects.toThrow(
      'action "connect" requires a non-empty server',
    );
    await expect(executeMcpServer({ action: "disconnect", server: " " })).rejects.toThrow(
      'action "disconnect" requires a non-empty server',
    );
    await expect(executeMcpServer({
      action: "status",
      extra: true,
    } as unknown as Parameters<typeof mcpServerTool.execute>[1])).rejects.toThrow("unknown field extra");
  });

  it("报告所有服务器状态，使用英文复数形式", async () => {
    const refreshFooter = vi.fn();
    const status = {
      connectedCount: 1,
      totalCount: 2,
      servers: [
        makeServerSnapshot({ name: "context7", connectState: "connected" }),
        makeServerSnapshot({ name: "tavily", connectState: "disconnected" }),
      ],
    };
    useRuntime({ refreshFooter, registry: { getStatus: async () => status } });

    const result = await executeMcpServer({ action: "status", server: "" });

    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "1/2 servers connected:\n\n[1] context7\nconnected\n\n[2] tavily\ndisconnected",
    });
    expect(result.details).toEqual({ kind: "status", connectedCount: 1, totalCount: 2 });
  });

  it("单条状态结果中使用英文单数形式", async () => {
    useRuntime({
      registry: {
        getStatus: async () => ({
          connectedCount: 1,
          totalCount: 1,
          servers: [makeServerSnapshot()],
        }),
      },
    });

    const result = await executeMcpServer({ action: "status" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1/1 server connected:"),
    });
  });

  it("报告指定名称的服务器状态", async () => {
    const refreshFooter = vi.fn();
    const getServerState = vi.fn().mockResolvedValue(
      makeServerSnapshot({ name: "context7", connectState: "connected" }),
    );
    useRuntime({ refreshFooter, registry: { getServerSnapshot: getServerState } });

    const result = await executeMcpServer({ action: "status", server: "context7" });

    expect(getServerState).toHaveBeenCalledWith("context7");
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "connected" });
    expect(result.details).toEqual({ kind: "status", serverName: "context7", connectState: "connected" });
  });

  it("拒绝不存在的服务器状态查询并刷新 footer", async () => {
    const refreshFooter = vi.fn();
    useRuntime({ refreshFooter, registry: { getServerSnapshot: async () => undefined } });

    await expect(executeMcpServer({ action: "status", server: "missing" })).rejects.toThrow(
      "Unknown MCP server: missing",
    );
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("显式连接并转发 AbortSignal", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const connectServer = vi.fn().mockResolvedValue(makeServerSnapshot());
    useRuntime({ refreshFooter, registry: { connectServer } });

    const result = await executeMcpServer({ action: "connect", server: "demo" }, signal);

    expect(connectServer).toHaveBeenCalledWith("demo", signal);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "connected" });
    expect(result.details).toEqual({ kind: "connect" });
  });

  it("连接失败后刷新 footer", async () => {
    const error = new Error("dial tcp timeout");
    const refreshFooter = vi.fn();
    useRuntime({
      refreshFooter,
      registry: { connectServer: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpServer({ action: "connect", server: "demo" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("显式断开连接，不将 AbortSignal 视为关闭取消信号", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const disconnectServer = vi.fn().mockResolvedValue(makeServerSnapshot({ connectState: "disconnected" }));
    useRuntime({ refreshFooter, registry: { disconnectServer } });

    const result = await executeMcpServer({ action: "disconnect", server: "demo" }, signal);

    expect(disconnectServer).toHaveBeenCalledWith("demo");
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "disconnected" });
    expect(result.details).toEqual({ kind: "disconnect" });
  });

  it("断开连接失败后刷新 footer", async () => {
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
  it("注册 mcp_server，不附带 tool_result 钩子", () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    registerMcpServerTool({ registerTool, on } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledWith(mcpServerTool);
    expect(on).not.toHaveBeenCalled();
  });
});
