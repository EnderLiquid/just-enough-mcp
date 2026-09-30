import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpRegistry } from "../src/core/servers/registry.js";
import { UnknownServerError } from "../src/core/servers/errors.js";
import { makeServerSnapshot } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({}));

import {
  createMcpServerTool,
  registerMcpServerTool,
  type McpServerToolRuntime,
} from "../src/pi/tools/mcp-server-tool.js";

let currentRegistry: McpRegistry | undefined;
let refreshFooter: McpServerToolRuntime["refreshFooterStatus"] = () => {};
const runtime: McpServerToolRuntime = {
  getRegistry: () => currentRegistry,
  getTuiSettings: () => undefined,
  refreshFooterStatus: status => refreshFooter(status),
};
const mcpServerTool = createMcpServerTool(runtime);

type RegistryStubOverrides = {
  registry?: Partial<McpRegistry>;
  refreshFooter?: McpServerToolRuntime["refreshFooterStatus"];
};

function useRuntime(overrides: RegistryStubOverrides = {}): McpRegistry {
  const emptyStatus = { connectedCount: 0, totalCount: 0, servers: [] };
  const registry: McpRegistry = {
    initialize: async () => ({ eagerFailures: [] }),
    getStatus: async () => emptyStatus,
    getServerSnapshot: async () => makeServerSnapshot(),
    connectServer: async () => { throw new Error("Unexpected connectServer call."); },
    disconnectServer: async () => { throw new Error("Unexpected disconnectServer call."); },
    authorizeServer: async () => { throw new Error("Unexpected authorizeServer call."); },
    logoutServer: async () => { throw new Error("Unexpected logoutServer call."); },
    getServerCatalog: async () => { throw new Error("Unexpected getServerCatalog call."); },
    callTool: async () => { throw new Error("Unexpected callTool call."); },
    close: async () => {},
    ...overrides.registry,
  };
  currentRegistry = registry;
  refreshFooter = overrides.refreshFooter ?? (() => {});
  return registry;
}

function executeMcpServer(
  params: Parameters<typeof mcpServerTool.execute>[1],
  signal?: AbortSignal,
) {
  return mcpServerTool.execute("tool-call", params, signal, vi.fn(), {} as Parameters<typeof mcpServerTool.execute>[4]);
}

afterEach(() => {
  currentRegistry = undefined;
  refreshFooter = () => {};
});

describe("mcpServerTool.execute", () => {
  beforeEach(() => {
    currentRegistry = undefined;
    refreshFooter = vi.fn();
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
    await expect(executeMcpServer({ action: "authorize" })).rejects.toThrow(
      'action "authorize" requires a non-empty server',
    );
    await expect(executeMcpServer({ action: "logout", server: " " })).rejects.toThrow(
      'action "logout" requires a non-empty server',
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
    useRuntime({ refreshFooter, registry: { getServerSnapshot: async () => { throw new UnknownServerError("missing"); } } });

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

  it("显式授权并转发 AbortSignal", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const authorizeServer = vi.fn().mockResolvedValue(
      makeServerSnapshot({ oauthState: "authorized" }),
    );
    useRuntime({ refreshFooter, registry: { authorizeServer } });

    const result = await executeMcpServer({ action: "authorize", server: "demo" }, signal);

    expect(authorizeServer).toHaveBeenCalledWith("demo", signal);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "authorized" });
    expect(result.details).toEqual({ kind: "authorize" });
  });

  it("授权被取消后仍刷新 footer", async () => {
    const refreshFooter = vi.fn();
    const error = new DOMException("aborted", "AbortError");
    useRuntime({
      refreshFooter,
      registry: { authorizeServer: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpServer({ action: "authorize", server: "demo" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("登出本地凭证并刷新 footer", async () => {
    const refreshFooter = vi.fn();
    const logoutServer = vi.fn().mockResolvedValue(
      makeServerSnapshot({ oauthState: "authorization-required" }),
    );
    useRuntime({ refreshFooter, registry: { logoutServer } });

    const result = await executeMcpServer({ action: "logout", server: "demo" });

    expect(logoutServer).toHaveBeenCalledWith("demo");
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: "text", text: "logged out" });
    expect(result.details).toEqual({ kind: "logout" });
  });

  it("登出失败后仍刷新 footer", async () => {
    const refreshFooter = vi.fn();
    const error = new Error("broker is unavailable");
    useRuntime({
      refreshFooter,
      registry: { logoutServer: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpServer({ action: "logout", server: "demo" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });
});

describe("registerMcpServerTool", () => {
  it("注册 mcp_server，不附带 tool_result 钩子", () => {
    const registerTool = vi.fn();
    const on = vi.fn();

    const tool = registerMcpServerTool(
      { registerTool, on } as unknown as ExtensionAPI,
      runtime,
    );

    expect(registerTool).toHaveBeenCalledWith(tool);
    expect(on).not.toHaveBeenCalled();
  });
});
