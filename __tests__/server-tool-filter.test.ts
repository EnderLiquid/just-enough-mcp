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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect((await registry.getServerSnapshot("demo"))?.tools?.map(tool => tool.name)).toEqual(["search", "read"]);
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
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
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
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
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
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
  });

  it("使已关闭连接失效，下次调用时重新连接", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool.mockRejectedValueOnce(connectionError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(connectionError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });

    await expect(registry.callTool("demo", "search", {})).resolves.toMatchObject({
      toolName: "search",
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
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
    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
  });

  it("连接失效清理等待其他在途工具调用自然完成", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");
    const successfulCall = createDeferred<{ content: Array<{ type: "text"; text: string }> }>();
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool
      .mockImplementationOnce(() => successfulCall.promise)
      .mockRejectedValueOnce(connectionError);

    const first = registry.callTool("demo", "search", { request: 1 });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
    let failedCallSettled = false;
    const second = registry.callTool("demo", "search", { request: 2 }).finally(() => {
      failedCallSettled = true;
    });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));

    await Promise.resolve();
    expect(failedCallSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    successfulCall.resolve({ content: [{ type: "text", text: "ok" }] });
    await expect(first).resolves.toMatchObject({ toolName: "search" });
    await expect(second).rejects.toBe(connectionError);

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
  });

  it.each([
    ["request timeout", new McpError(ErrorCode.RequestTimeout, "Request timed out")],
    ["invalid params", new McpError(ErrorCode.InvalidParams, "Invalid params")],
  ])("%s 错误后保持连接", async (_label, requestError) => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    mocks.callTool.mockRejectedValueOnce(requestError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(requestError);

    const state = await registry.getServerSnapshot("demo");
    expect(state?.connectState).toBe("connected");
    expect(state?.tools).toHaveLength(remoteTools.length);
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
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
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
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
  });

  it("服务器正在连接时等待连接结束再断开", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    let finishConnect!: () => void;
    mocks.connect.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishConnect = resolve;
    }));

    const connecting = registry.connectServer("demo");
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connecting");
    });

    let disconnectSettled = false;
    const disconnecting = registry.disconnectServer("demo").finally(() => {
      disconnectSettled = true;
    });
    await Promise.resolve();
    expect(disconnectSettled).toBe(false);

    finishConnect();
    await expect(connecting).resolves.toMatchObject({ connectState: "connected" });
    await expect(disconnecting).resolves.toMatchObject({ connectState: "disconnected" });
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
  });

  it("closeAll 等待连接完成后关闭并移除服务器", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const connectGate = createDeferred();
    mocks.connect.mockImplementationOnce(() => connectGate.promise);

    const connecting = registry.connectServer("demo");
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connecting");
    });

    let closeSettled = false;
    const closing = registry.closeAll().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    connectGate.resolve();
    await expect(connecting).resolves.toMatchObject({ connectState: "connected" });
    await closing;

    expect(await registry.getServerSnapshot("demo")).toBeUndefined();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
  });

  it("closeAll 等待并发工具调用自然完成", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");
    const callGate = createDeferred();
    mocks.callTool.mockImplementation(() => callGate.promise.then(() => ({
      content: [{ type: "text", text: "ok" }],
    })));

    const firstCall = registry.callTool("demo", "search", { request: 1 });
    const secondCall = registry.callTool("demo", "search", { request: 2 });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));

    let closeSettled = false;
    const closing = registry.closeAll().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    callGate.resolve();
    await Promise.all([firstCall, secondCall]);
    await closing;

    expect(await registry.getServerSnapshot("demo")).toBeUndefined();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("closeAll 与后续配置同步串行，且不遗漏新实例", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");
    const closeGate = createDeferred();
    mocks.close.mockImplementationOnce(() => closeGate.promise);

    const closing = registry.closeAll();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    const nextConfig = makePluginConfig({
      servers: [makeResolvedServerConfig({
        name: "next",
        definition: { command: "npx" },
      })],
    });
    let syncSettled = false;
    const syncing = registry.syncConfig(nextConfig).finally(() => {
      syncSettled = true;
    });
    await Promise.resolve();
    expect(syncSettled).toBe(false);

    closeGate.resolve();
    await Promise.all([closing, syncing]);

    const status = await registry.getStatus();
    expect(status.servers.map(server => server.name)).toEqual(["next"]);
  });

  it("配置替换等待在途工具调用并关闭旧实例", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");
    const callGate = createDeferred();
    mocks.callTool.mockImplementationOnce(() => callGate.promise.then(() => ({
      content: [{ type: "text", text: "ok" }],
    })));

    const calling = registry.callTool("demo", "search", {});
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));

    let syncSettled = false;
    const syncing = registry.syncConfig(makeConfig({ args: ["replacement"] })).finally(() => {
      syncSettled = true;
    });
    await Promise.resolve();
    expect(syncSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    callGate.resolve();
    await calling;
    await syncing;

    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("串行执行并发配置同步并保留后一次配置", async () => {
    const registry = createServerRegistry();
    const connectGate = createDeferred();
    mocks.connect.mockImplementationOnce(() => connectGate.promise);
    const firstConfig = makePluginConfig({
      servers: [makeResolvedServerConfig({
        name: "first",
        connectionMode: "eager",
        definition: { command: "npx" },
      })],
    });
    const secondConfig = makePluginConfig({
      servers: [makeResolvedServerConfig({
        name: "second",
        definition: { command: "npx" },
      })],
    });

    const firstSync = registry.syncConfig(firstConfig);
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const secondSync = registry.syncConfig(secondConfig).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    connectGate.resolve();
    await Promise.all([firstSync, secondSync]);

    const status = await registry.getStatus();
    expect(status.servers.map(server => server.name)).toEqual(["second"]);
  });

  it("并发连接在前一次失败后独立重试", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const firstError = new Error("first connection failed");
    mocks.connect.mockRejectedValueOnce(firstError).mockResolvedValueOnce(undefined);

    const first = registry.connectServer("demo");
    const second = registry.connectServer("demo");

    await expect(first).rejects.toBe(firstError);
    await expect(second).resolves.toMatchObject({ connectState: "connected" });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
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
