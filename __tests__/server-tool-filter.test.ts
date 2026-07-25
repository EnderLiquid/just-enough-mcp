import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
  createStdioTransport: vi.fn(),
  createHttpTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport: unknown = undefined;

    async connect(transport: unknown, options?: unknown) {
      await mocks.connect.call(this, transport, options);
      this.transport = transport;
    }

    listTools(params?: unknown, options?: unknown) {
      return mocks.listTools.call(this, params, options);
    }

    callTool(params: unknown, resultSchema?: unknown, options?: unknown) {
      return mocks.callTool.call(this, params, resultSchema, options);
    }

    getServerVersion() {
      return mocks.getServerVersion.call(this);
    }

    async close() {
      this.transport = undefined;
      await mocks.close.call(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    close = mocks.transportClose;
    constructor(options: unknown) {
      mocks.createStdioTransport(options);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    close = mocks.transportClose;
    constructor(url: URL, options?: unknown) {
      mocks.createHttpTransport(url, options);
    }
  },
}));

import { createServerRegistry } from "../extensions/servers/registry.js";

function makeServer(definition: Record<string, unknown>): ResolvedServerConfig {
  return makeResolvedServerConfig({
    definition: {
      command: "npx",
      ...definition,
    },
  });
}

function makeConfig(definition: Record<string, unknown>) {
  return makePluginConfig({
    servers: [makeServer(definition)],
  });
}

function rejectWhenAborted(options: { signal?: AbortSignal } | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const signal = options?.signal;
    if (!signal) {
      reject(new Error("AbortSignal was not forwarded."));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const remoteTools = [
  { name: "search", description: "Search" },
  { name: "read", description: "Read" },
  { name: "write", description: "Write" },
];

describe("基于 SDK 的服务器工具", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: remoteTools });
    mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.getServerVersion.mockReturnValue({ name: "demo", version: "1.0.0" });
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("创建配置的 stdio transport", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: { API_KEY: "secret" },
    }));

    await registry.getServerCatalog("demo");

    expect(mocks.createStdioTransport).toHaveBeenCalledWith({
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: { API_KEY: "secret" },
      stderr: "ignore",
    });
  });

  it("创建不带请求头的匿名 HTTP transport", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      transport: "http",
      url: "https://example.com/mcp",
    }));

    await registry.getServerCatalog("demo");

    expect(mocks.createHttpTransport).toHaveBeenCalledWith(
      new URL("https://example.com/mcp"),
      undefined,
    );
  });

  it("创建带合并头部的静态令牌 HTTP transport", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { "X-API-Key": "secret", Authorization: "Basic ignored" },
      bearerToken: "token-123",
    }));

    await registry.getServerCatalog("demo");

    expect(mocks.createHttpTransport).toHaveBeenCalledWith(
      new URL("https://example.com/mcp"),
      {
        requestInit: {
          headers: {
            "X-API-Key": "secret",
            Authorization: "Bearer token-123",
          },
        },
      },
    );
  });

  it("配置 includeTools 时限制目录范围", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search", "read"] }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search", "read"]);
    expect(registry.getServerState("demo")?.tools?.map(tool => tool.name)).toEqual(["search", "read"]);
  });

  it("includeTools 之后再应用 excludeTools", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      includeTools: ["search", "read"],
      excludeTools: ["read", "write"],
    }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search"]);
  });

  it("初始化 MCP client 时转发 AbortSignal", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled during initialization");
    mocks.connect.mockImplementationOnce((
      _transport: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.getServerCatalog("demo", controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(mocks.listTools).not.toHaveBeenCalled();
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("加载工具目录时转发 AbortSignal", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled while loading tools");
    mocks.listTools.mockImplementationOnce((
      _params: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.getServerCatalog("demo", controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("向 SDK 请求转发 AbortSignal 并传播取消信号", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    mocks.callTool.mockImplementationOnce((
      _params: unknown,
      _resultSchema: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.callTool("demo", "search", { query: "pi" }, controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(mocks.listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "pi" } },
      undefined,
      { signal: controller.signal },
    );
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("使已关闭连接失效，下次调用时重新连接", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool.mockRejectedValueOnce(connectionError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(connectionError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(registry.getServerState("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });

    await expect(registry.callTool("demo", "search", {})).resolves.toMatchObject({
      toolName: "search",
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("client transport 已不存在时使连接失效", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const notConnectedError = new Error("Not connected");
    mocks.callTool.mockImplementationOnce(function (this: { transport: unknown }) {
      this.transport = undefined;
      throw notConnectedError;
    });

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(notConnectedError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(registry.getServerState("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
  });

  it.each([
    ["request timeout", new McpError(ErrorCode.RequestTimeout, "Request timed out")],
    ["invalid params", new McpError(ErrorCode.InvalidParams, "Invalid params")],
  ])("%s 错误后保持连接", async (_label, requestError) => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    mocks.callTool.mockRejectedValueOnce(requestError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(requestError);

    expect(registry.getServerState("demo")?.connectState).toBe("connected");
    expect(registry.getServerState("demo")?.tools).toHaveLength(remoteTools.length);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("远程业务失败时保持连接", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "remote failure" }],
      isError: true,
    });

    const execution = await registry.callTool("demo", "search", {});

    expect(execution.result.isError).toBe(true);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("拒绝直接调用被过滤器隐藏的工具", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ excludeTools: ["write"] }));

    await expect(registry.callTool("demo", "write", {})).rejects.toThrow(/Tool "write" is excluded by configuration/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("对未知远程工具保持独立错误信息", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search"] }));

    await expect(registry.callTool("demo", "read", {})).rejects.toThrow(/Tool "read" is excluded by configuration/);
    await expect(registry.callTool("demo", "missing", {})).rejects.toThrow(/Tool "missing" is not available/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("幂等断开连接，下次目录请求时重新连接", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");

    const first = await registry.disconnectServer("demo");
    const second = await registry.disconnectServer("demo");

    expect(first).toMatchObject({ connectState: "disconnected", tools: undefined });
    expect(second).toMatchObject({ connectState: "disconnected", tools: undefined });

    await registry.getServerCatalog("demo");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("服务器正在连接时拒绝断开", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    mocks.connect.mockImplementationOnce((
      _transport: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const connecting = registry.connectServer("demo", controller.signal);
    await vi.waitFor(() => {
      expect(registry.getServerState("demo")?.connectState).toBe("connecting");
    });

    await expect(registry.disconnectServer("demo")).rejects.toThrow(
      'Cannot disconnect MCP server "demo" while it is connecting. Cancel the in-flight operation first.',
    );

    controller.abort(abortReason);
    await expect(connecting).rejects.toBe(abortReason);
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("拒绝断开未知服务器", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));

    await expect(registry.disconnectServer("missing")).rejects.toThrow("Unknown MCP server: missing");
  });

  it("拒绝无效的工具过滤器配置", async () => {
    const registry = createServerRegistry();

    await expect(registry.syncConfig(makeConfig({ includeTools: ["search", ""] }))).rejects.toThrow(/includeTools/);
    await expect(registry.syncConfig(makeConfig({ excludeTools: "write" }))).rejects.toThrow(/excludeTools/);
  });
});
