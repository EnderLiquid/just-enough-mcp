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
  clients: [] as Array<{ onclose?: () => void }>,
}));

interface MockTransport {
  close: () => Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (...args: unknown[]) => void;
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport: MockTransport | undefined;
    onclose: (() => void) | undefined;

    constructor() {
      mocks.clients.push(this);
    }

    async connect(transport: MockTransport, options?: unknown) {
      this.transport = transport;
      const previousOnclose = transport.onclose;
      transport.onclose = () => {
        previousOnclose?.();
        this.transport = undefined;
        this.onclose?.();
      };
      await mocks.connect.call(this, transport, options);
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
      await this.transport?.close();
      await mocks.close.call(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;
    close = async () => {
      await mocks.transportClose();
      this.onclose?.();
    };

    constructor(options: unknown) {
      mocks.createStdioTransport(options);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    onclose?: () => void;
    close = async () => {
      await mocks.transportClose();
      this.onclose?.();
    };

    constructor(url: URL, options?: unknown) {
      mocks.createHttpTransport(url, options);
    }
  },
}));

import { createMcpRegistry } from "../extensions/servers/registry.js";

function makeServer(definition: Record<string, unknown>): ResolvedServerConfig {
  return makeResolvedServerConfig({
    definition: {
      command: "npx",
      ...definition,
    },
  });
}

function makeConfig(definition: Record<string, unknown> = {}) {
  return makePluginConfig({
    servers: [makeServer(definition)],
  });
}

function createRegistry(definition: Record<string, unknown> = {}) {
  return createMcpRegistry(makeConfig(definition).servers);
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    mocks.clients.length = 0;
  });

  it("构造 Registry 只装配静态成员，不自动预热 eager server", async () => {
    const config = makePluginConfig({
      servers: [
        makeResolvedServerConfig({ name: "zeta", definition: { command: "npx" } }),
        makeResolvedServerConfig({
          name: "alpha",
          connectionMode: "eager",
          definition: { command: "npx" },
        }),
      ],
    });

    const registry = createMcpRegistry(config.servers);

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.listTools).not.toHaveBeenCalled();
    await expect(registry.getStatus()).resolves.toMatchObject({
      connectedCount: 0,
      totalCount: 2,
      servers: [
        { name: "alpha", connectState: "disconnected" },
        { name: "zeta", connectState: "disconnected" },
      ],
    });
  });

  it("按配置顺序尽力预热 eager server，并返回结构化失败报告", async () => {
    const config = makePluginConfig({
      servers: [
        makeResolvedServerConfig({ name: "lazy", definition: { command: "npx" } }),
        makeResolvedServerConfig({
          name: "failed",
          connectionMode: "eager",
          definition: { command: "npx" },
        }),
        makeResolvedServerConfig({
          name: "also-failed",
          connectionMode: "eager",
          definition: { command: "npx" },
        }),
        makeResolvedServerConfig({
          name: "ready",
          connectionMode: "eager",
          definition: { command: "npx" },
        }),
      ],
    });
    const registry = createMcpRegistry(config.servers);
    const failure = new Error("failed eager connection");
    const secondFailure = new Error("another eager connection failed");
    mocks.connect.mockRejectedValueOnce(failure).mockRejectedValueOnce(secondFailure);

    const first = registry.initialize();
    const second = registry.initialize();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ eagerFailures: [
      { serverName: "failed", message: "failed eager connection" },
      { serverName: "also-failed", message: "another eager connection failed" },
    ] });
    await expect(second).resolves.toEqual({ eagerFailures: [
      { serverName: "failed", message: "failed eager connection" },
      { serverName: "also-failed", message: "another eager connection failed" },
    ] });
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    expect((await registry.getServerSnapshot("lazy"))?.connectState).toBe("disconnected");
    expect((await registry.getServerSnapshot("failed"))?.connectState).toBe("disconnected");
    expect((await registry.getServerSnapshot("also-failed"))?.connectState).toBe("disconnected");
    expect((await registry.getServerSnapshot("ready"))?.connectState).toBe("connected");
  });

  it("eager 预热失败后允许按需重新连接", async () => {
    const config = makePluginConfig({
      servers: [makeResolvedServerConfig({
        connectionMode: "eager",
        definition: { command: "npx" },
      })],
    });
    const registry = createMcpRegistry(config.servers);
    const failure = new Error("failed eager connection");
    mocks.connect.mockRejectedValueOnce(failure);

    await expect(registry.initialize()).resolves.toEqual({
      eagerFailures: [{ serverName: "demo", message: "failed eager connection" }],
    });
    await expect(registry.getServerCatalog("demo")).resolves.toMatchObject({
      server: { connectState: "connected" },
    });

    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("创建配置的 stdio transport", async () => {
    const registry = createRegistry({
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: { API_KEY: "secret" },
    });

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
    const registry = createRegistry({
      transport: "http",
      url: "https://example.com/mcp",
    });

    await registry.getServerCatalog("demo");

    expect(mocks.createHttpTransport).toHaveBeenCalledWith(
      new URL("https://example.com/mcp"),
      undefined,
    );
  });

  it("创建带合并头部的静态令牌 HTTP transport", async () => {
    const registry = createRegistry({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { "X-API-Key": "secret", Authorization: "Basic ignored" },
      bearerToken: "token-123",
    });

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
    const registry = createRegistry({ includeTools: ["search", "read"] });

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search", "read"]);
    expect((await registry.getServerSnapshot("demo"))?.tools?.map(tool => tool.name)).toEqual(["search", "read"]);
  });

  it("includeTools 之后再应用 excludeTools", async () => {
    const registry = createRegistry({
      includeTools: ["search", "read"],
      excludeTools: ["read", "write"],
    });

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search"]);
  });

  it("初始化 MCP client 时转发 AbortSignal", async () => {
    const registry = createRegistry();
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
    const registry = createRegistry();
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
    const registry = createRegistry();
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

  it("一次连接关闭错误不会主动使已发布 client 失效", async () => {
    const registry = createRegistry();
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool.mockRejectedValueOnce(connectionError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(connectionError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "connected",
      tools: remoteTools,
    });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.transportClose).not.toHaveBeenCalled();

    await expect(registry.callTool("demo", "search", {})).resolves.toMatchObject({
      toolName: "search",
    });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
  });

  it("请求抛错但 SDK 未关闭 client 时保持连接", async () => {
    const registry = createRegistry();
    const requestError = new Error("Not connected");
    mocks.callTool.mockRejectedValueOnce(requestError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(requestError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "connected",
      tools: remoteTools,
    });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("被动关闭当前 transport 时使 client 失效并允许按需重连", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const firstTransport = mocks.connect.mock.calls[0]?.[0] as { onclose?: () => void };

    firstTransport.onclose?.();

    await vi.waitFor(async () => {
      expect(await registry.getServerSnapshot("demo")).toMatchObject({
        connectState: "disconnected",
        tools: undefined,
      });
    });

    await expect(registry.callTool("demo", "search", {})).resolves.toMatchObject({
      toolName: "search",
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
  });

  it("旧 client 的延迟关闭不会使重连后的 client 失效", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const firstTransport = mocks.connect.mock.calls[0]?.[0] as { onclose?: () => void };
    const firstClient = mocks.clients[0]!;

    firstTransport.onclose?.();
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
    });
    await registry.getServerCatalog("demo");

    firstClient.onclose?.();
    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "connected",
      tools: remoteTools,
    });
    expect(mocks.clients).toHaveLength(2);
  });

  it("被动关闭排队失效 writer，新的操作不会使用旧 client", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const firstTransport = mocks.connect.mock.calls[0]?.[0] as { onclose?: () => void };
    const callGate = createDeferred<{ content: Array<{ type: "text"; text: string }> }>();
    mocks.callTool.mockImplementationOnce(() => callGate.promise);

    const firstCall = registry.callTool("demo", "search", { request: 1 });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));

    firstTransport.onclose?.();
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");

    let secondSettled = false;
    const secondCall = registry.callTool("demo", "search", { request: 2 }).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(mocks.callTool).toHaveBeenCalledTimes(1);

    callGate.resolve({ content: [{ type: "text", text: "ok" }] });
    await expect(firstCall).resolves.toMatchObject({ toolName: "search" });
    await expect(secondCall).resolves.toMatchObject({ toolName: "search" });

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect(mocks.clients).toHaveLength(2);
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
  });

  it("连接期间被动关闭时不会发布失效 client", async () => {
    const registry = createRegistry();
    mocks.listTools.mockImplementationOnce(function (this: { transport?: { onclose?: () => void } }) {
      this.transport?.onclose?.();
      return { tools: remoteTools };
    });

    await expect(registry.getServerCatalog("demo")).rejects.toThrow(
      'MCP client for server "demo" closed during initialization.',
    );

    expect(await registry.getServerSnapshot("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
    expect(mocks.getServerVersion).not.toHaveBeenCalled();
  });

  it("连接关闭错误不会阻塞其他在途工具调用", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const successfulCall = createDeferred<{ content: Array<{ type: "text"; text: string }> }>();
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool
      .mockImplementationOnce(() => successfulCall.promise)
      .mockRejectedValueOnce(connectionError);

    const first = registry.callTool("demo", "search", { request: 1 });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
    const second = registry.callTool("demo", "search", { request: 2 });
    const secondExpectation = expect(second).rejects.toBe(connectionError);
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));

    await secondExpectation;
    expect(mocks.close).not.toHaveBeenCalled();

    successfulCall.resolve({ content: [{ type: "text", text: "ok" }] });
    await expect(first).resolves.toMatchObject({ toolName: "search" });

    expect(mocks.close).not.toHaveBeenCalled();
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connected");
  });

  it.each([
    ["request timeout", new McpError(ErrorCode.RequestTimeout, "Request timed out")],
    ["invalid params", new McpError(ErrorCode.InvalidParams, "Invalid params")],
  ])("%s 错误后保持连接", async (_label, requestError) => {
    const registry = createRegistry();
    mocks.callTool.mockRejectedValueOnce(requestError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(requestError);

    const state = await registry.getServerSnapshot("demo");
    expect(state?.connectState).toBe("connected");
    expect(state?.tools).toHaveLength(remoteTools.length);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("远程业务失败时保持连接", async () => {
    const registry = createRegistry();
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
    const registry = createRegistry({ excludeTools: ["write"] });

    await expect(registry.callTool("demo", "write", {})).rejects.toThrow(/Tool "write" is excluded by configuration/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("对未知远程工具保持独立错误信息", async () => {
    const registry = createRegistry({ includeTools: ["search"] });

    await expect(registry.callTool("demo", "read", {})).rejects.toThrow(/Tool "read" is excluded by configuration/);
    await expect(registry.callTool("demo", "missing", {})).rejects.toThrow(/Tool "missing" is not available/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("幂等断开连接，下次目录请求时重新连接", async () => {
    const registry = createRegistry();
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

  it("断开连接期间发布 disconnecting，完成后才变为 disconnected", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const closeGate = createDeferred();
    mocks.transportClose.mockImplementationOnce(() => closeGate.promise);

    const disconnecting = registry.disconnectServer("demo");
    await vi.waitFor(async () => {
      expect(await registry.getServerSnapshot("demo")).toMatchObject({
        connectState: "disconnecting",
        tools: undefined,
      });
    });
    expect(mocks.close).not.toHaveBeenCalled();

    closeGate.resolve();
    await expect(disconnecting).resolves.toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
  });

  it("显式关闭引起的 SDK onclose 不会提前覆盖 disconnecting", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const closeGate = createDeferred();
    mocks.transportClose.mockImplementationOnce(() => closeGate.promise);

    const closing = registry.disconnectServer("demo");
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnecting");
    });

    closeGate.resolve();
    await closing;
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
  });

  it("关闭 client 失败后仍完成状态转换", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    mocks.transportClose.mockRejectedValueOnce(new Error("transport close failed"));

    await expect(registry.disconnectServer("demo")).resolves.toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
  });

  it("连接完成前排队的断开会让目录请求单次失败而不重连", async () => {
    const registry = createRegistry();
    const connectGate = createDeferred();
    mocks.connect.mockImplementationOnce(() => connectGate.promise);

    const catalog = registry.getServerCatalog("demo");
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connecting");
    });

    const disconnecting = registry.disconnectServer("demo");
    connectGate.resolve();

    await expect(disconnecting).resolves.toMatchObject({ connectState: "disconnected" });
    await expect(catalog).rejects.toThrow(
      'MCP server "demo" became unavailable before the requested operation could start.',
    );
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.listTools).toHaveBeenCalledTimes(1);
    expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("disconnected");
  });

  it("服务器正在连接时等待连接结束再断开", async () => {
    const registry = createRegistry();
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

  it("close 等待连接完成后关闭并移除服务器", async () => {
    const registry = createRegistry();
    const connectGate = createDeferred();
    mocks.connect.mockImplementationOnce(() => connectGate.promise);
    const connecting = registry.connectServer("demo");
    await vi.waitFor(async () => {
      expect((await registry.getServerSnapshot("demo"))?.connectState).toBe("connecting");
    });

    let closeSettled = false;
    const closing = registry.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    connectGate.resolve();
    await expect(connecting).resolves.toMatchObject({ connectState: "connected" });
    await closing;

    await expect(registry.getServerSnapshot("demo")).rejects.toThrow(
      "MCP server registry is closed.",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
  });

  it("close 等待并发工具调用自然完成", async () => {
    const registry = createRegistry();
    await registry.getServerCatalog("demo");
    const callGate = createDeferred();
    mocks.callTool.mockImplementation(() => callGate.promise.then(() => ({
      content: [{ type: "text", text: "ok" }],
    })));
    const firstCall = registry.callTool("demo", "search", { request: 1 });
    const secondCall = registry.callTool("demo", "search", { request: 2 });
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));

    let closeSettled = false;
    const closing = registry.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();

    callGate.resolve();
    await Promise.all([firstCall, secondCall]);
    await closing;

    await expect(registry.getServerSnapshot("demo")).rejects.toThrow(
      "MCP server registry is closed.",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("并发连接在前一次失败后独立重试", async () => {
    const registry = createRegistry();
    const firstError = new Error("first connection failed");
    mocks.connect.mockRejectedValueOnce(firstError).mockResolvedValueOnce(undefined);

    const first = registry.connectServer("demo");
    const second = registry.connectServer("demo");

    await expect(first).rejects.toBe(firstError);
    await expect(second).resolves.toMatchObject({ connectState: "connected" });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("拒绝断开未知服务器", async () => {
    const registry = createRegistry();

    await expect(registry.disconnectServer("missing")).rejects.toThrow("Unknown MCP server: missing");
  });

  it("构造时拒绝无效的工具过滤器配置", () => {
    expect(() => createRegistry({ includeTools: ["search", ""] })).toThrow(/includeTools/);
    expect(() => createRegistry({ excludeTools: "write" })).toThrow(/excludeTools/);
  });
});
