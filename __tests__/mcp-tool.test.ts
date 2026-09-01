import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MaterializedToolCallResult } from "../extensions/artifacts/types.js";
import { installCurrentPluginConfig } from "../extensions/config/current-config.js";
import type { PluginConfigLoadResult } from "../extensions/modeling/types.js";
import { installCurrentServerRegistry } from "../extensions/servers/current-registry.js";
import type { ServerRegistry } from "../extensions/servers/registry.js";
import { makePluginConfig, makeServerSnapshot } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  refreshFooterStatus: vi.fn(),
  materializeToolCallResult: vi.fn(),
}));

vi.mock("../extensions/rendering/footer-status.js", () => ({
  refreshFooterStatus: mocks.refreshFooterStatus,
}));

vi.mock("../extensions/artifacts/materializer.js", () => ({
  materializeToolCallResult: mocks.materializeToolCallResult,
}));

import {
  mcpTool,
  mcpToolParametersSchema,
  registerMcpTool,
} from "../extensions/tools/mcp-tool.js";

type RegistryStubOverrides = {
  registry?: Partial<ServerRegistry>;
  refreshFooter?: () => Promise<void>;
  config?: () => PluginConfigLoadResult | undefined;
};

let disposeRegistry: (() => void) | undefined;
let disposeConfig: (() => void) | undefined;

function useRuntime(overrides: RegistryStubOverrides = {}): ServerRegistry {
  const emptyStatus = { connectedCount: 0, totalCount: 0, servers: [] };
  const registry: ServerRegistry = {
    initialize: async () => {},
    getStatus: async () => emptyStatus,
    getServerSnapshot: async () => undefined,
    connectServer: async () => { throw new Error("Unexpected connectServer call."); },
    disconnectServer: async () => { throw new Error("Unexpected disconnectServer call."); },
    authorizeServer: async () => { throw new Error("Unexpected authorizeServer call."); },
    logoutServer: async () => { throw new Error("Unexpected logoutServer call."); },
    getServerCatalog: async () => { throw new Error("Unexpected getServerCatalog call."); },
    callTool: async () => { throw new Error("Unexpected callTool call."); },
    closeAll: async () => {},
    ...overrides.registry,
  };

  disposeRegistry?.();
  disposeRegistry = installCurrentServerRegistry(registry);
  disposeConfig?.();
  const config = overrides.config?.();
  disposeConfig = config ? installCurrentPluginConfig(config) : undefined;
  mocks.refreshFooterStatus.mockImplementation(overrides.refreshFooter ?? (async () => {}));
  return registry;
}

function executeMcpTool(
  params: Parameters<typeof mcpTool.execute>[1],
  signal?: AbortSignal,
) {
  const context = {} as Parameters<typeof mcpTool.execute>[4];
  return mcpTool.execute("tool-call", params, signal, vi.fn(), context);
}

afterEach(() => {
  disposeRegistry?.();
  disposeRegistry = undefined;
  disposeConfig?.();
  disposeConfig = undefined;
});

function makeMaterialized(summaryText = "ok"): MaterializedToolCallResult {
  const callDir = "D:/project/.pi/agent/just-enough-mcp/artifacts/demo-call";
  const payloadPath = `${callDir}/01-text.txt`;
  const manifestPath = `${callDir}/manifest.json`;
  return {
    callDir,
    manifestPath,
    payloadItems: [{
      index: 1,
      source: "content[0]",
      contentType: "text",
      mimeType: "text/plain",
      path: payloadPath,
      fileName: "01-text.txt",
      text: summaryText,
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
    summaryText,
    budget: {
      summaryItemCount: 3,
      previewFullCharsPerItem: 400,
      previewTruncateToCharsPerItem: 200,
      hardMaxChars: 40000,
    },
  };
}

describe("mcp_tool 参数 schema", () => {
  it("接受原生嵌套参数对象，无需高级 schema 关键字", () => {
    const validator = Compile(mcpToolParametersSchema);
    const valid = {
      action: "call",
      server: "demo",
      tool: "search",
      args: { query: "pi", filters: { tags: ["mcp"], limit: null } },
    };

    expect(validator.Check(valid)).toBe(true);
    expect(validator.Check({ ...valid, args: [] })).toBe(false);
    expect(validator.Check({ ...valid, args: null })).toBe(false);
    expect(validator.Check({ ...valid, args: "{}" })).toBe(false);

    const serialized = JSON.stringify(mcpToolParametersSchema);
    expect(serialized).not.toMatch(/patternProperties|anyOf|oneOf|\$ref/);
    expect(mcpToolParametersSchema.properties.args).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });
});

describe("mcpTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("插件未初始化时拒绝执行", async () => {
    await expect(executeMcpTool({ action: "list", server: "demo" })).rejects.toThrow(
      "just-enough-mcp is not initialized for the current session",
    );
  });

  it("按 action 类型拒绝无效字段组合", async () => {
    useRuntime();

    await expect(executeMcpTool({
      action: "list",
      server: "demo",
      args: { query: "pi" },
    })).rejects.toThrow('action "list" does not accept tool or args');
    await expect(executeMcpTool({
      action: "call",
      server: "demo",
    })).rejects.toThrow('action "call" requires tool');
    await expect(executeMcpTool({
      action: "call",
      server: " ",
      tool: "search",
    })).rejects.toThrow("server must be a non-empty string");
    await expect(executeMcpTool({
      action: "call",
      server: "demo",
      tool: "search",
      args: [],
    } as unknown as Parameters<typeof mcpTool.execute>[1])).rejects.toThrow("args must be an object");
    await expect(executeMcpTool({
      action: "list",
      server: "demo",
      extra: true,
    } as unknown as Parameters<typeof mcpTool.execute>[1])).rejects.toThrow("unknown field extra");
  });

  it("列出服务器工具目录并转发 AbortSignal", async () => {
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const getServerCatalog = vi.fn().mockResolvedValue({
      server: makeServerSnapshot({ name: "codegraph" }),
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    });
    useRuntime({ refreshFooter, registry: { getServerCatalog } });

    const result = await executeMcpTool({
      action: "list",
      server: "codegraph",
      tool: "",
      args: {},
    }, signal);

    expect(getServerCatalog).toHaveBeenCalledWith("codegraph", signal);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 tool available:\n\n[1] search"),
    });
    expect(result.details).toEqual({ kind: "list", toolCount: 1 });
  });

  it("目录获取失败时刷新 footer", async () => {
    const error = new Error("catalog unavailable");
    const refreshFooter = vi.fn();
    useRuntime({
      refreshFooter,
      registry: { getServerCatalog: vi.fn().mockRejectedValue(error) },
    });

    await expect(executeMcpTool({ action: "list", server: "demo" })).rejects.toBe(error);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("将原生参数直接传递给 registry，不经过 JSON 解析", async () => {
    const args = { query: "pi", nested: { values: [1, true, null] } };
    const signal = new AbortController().signal;
    const refreshFooter = vi.fn();
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      toolName: "search",
      args,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    mocks.materializeToolCallResult.mockReturnValue(makeMaterialized());
    useRuntime({ refreshFooter, registry: { callTool } });

    const result = await executeMcpTool({
      action: "call",
      server: "demo",
      tool: "search",
      args,
    }, signal);

    expect(callTool).toHaveBeenCalledWith("demo", "search", args, signal);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(result.details).toEqual({ kind: "call", payloadItemCount: 1, outcome: "success" });
  });

  it("将省略的调用参数归一化为空对象", async () => {
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      toolName: "ping",
      args: {},
      result: { content: [{ type: "text", text: "ok" }] },
    });
    mocks.materializeToolCallResult.mockReturnValue(makeMaterialized());
    useRuntime({ registry: { callTool } });

    await executeMcpTool({ action: "call", server: "demo", tool: "ping" });

    expect(callTool).toHaveBeenCalledWith("demo", "ping", {}, undefined);
  });

  it("传播取消信号，不进行结果物化", async () => {
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    const callTool = vi.fn().mockRejectedValue(abortReason);
    const refreshFooter = vi.fn();
    useRuntime({ refreshFooter, registry: { callTool } });
    controller.abort(abortReason);

    await expect(executeMcpTool({
      action: "call",
      server: "demo",
      tool: "search",
      args: { query: "pi" },
    }, controller.signal)).rejects.toBe(abortReason);

    expect(mocks.materializeToolCallResult).not.toHaveBeenCalled();
    expect(refreshFooter).toHaveBeenCalledTimes(1);
  });

  it("本地物化失败时警告不要自动重试", async () => {
    const materializationError = new Error("artifact write failed");
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      toolName: "search",
      args: {},
      result: { content: [{ type: "text", text: "ok" }] },
    });
    mocks.materializeToolCallResult.mockImplementationOnce(() => { throw materializationError; });
    useRuntime({ registry: { callTool } });

    await expect(executeMcpTool({
      action: "call",
      server: "demo",
      tool: "search",
    })).rejects.toMatchObject({
      message: expect.stringContaining("Do not retry this tool call automatically"),
      cause: materializationError,
    });
  });

  it("保留远程业务失败状态供 tool_result 钩子使用", async () => {
    const callTool = vi.fn().mockResolvedValue({
      server: makeServerSnapshot(),
      toolName: "search",
      args: {},
      result: { content: [{ type: "text", text: "remote failure" }], isError: true },
    });
    mocks.materializeToolCallResult.mockReturnValue(makeMaterialized("remote failure"));
    useRuntime({
      registry: { callTool },
      config: () => makePluginConfig({ servers: [] }),
    });

    const result = await executeMcpTool({ action: "call", server: "demo", tool: "search" });

    expect(result).not.toHaveProperty("isError");
    expect(result.details).toEqual({ kind: "call", payloadItemCount: 1, outcome: "error" });
  });
});

describe("registerMcpTool", () => {
  it("注册 mcp_tool 并提升失败的远程结果为错误标志", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    registerMcpTool({ registerTool, on } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledWith(mcpTool);
    const handler = on.mock.calls.find(([eventName]) => eventName === "tool_result")?.[1] as (
      event: { toolName: string; details?: unknown },
    ) => unknown;

    expect(handler({
      toolName: "mcp_tool",
      details: { kind: "call", payloadItemCount: 1, outcome: "error" },
    })).toEqual({ isError: true });
    expect(handler({
      toolName: "mcp_tool",
      details: { kind: "call", payloadItemCount: 1, outcome: "success" },
    })).toBeUndefined();
    expect(handler({
      toolName: "mcp_server",
      details: { kind: "call", payloadItemCount: 1, outcome: "error" },
    })).toBeUndefined();
  });
});
