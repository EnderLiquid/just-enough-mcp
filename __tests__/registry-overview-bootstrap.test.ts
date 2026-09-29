import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
import { createMcpRegistry, type McpRegistry } from "../extensions/servers/registry.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    getServerVersion = mocks.getServerVersion;
    close = mocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    close = mocks.transportClose;
    constructor(_options: unknown) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    close = mocks.transportClose;
    constructor(_url: URL, _options?: unknown) {}
  },
}));

const overviewDir = "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews";

type Bootstrap = NonNullable<Parameters<typeof createMcpRegistry>[1]>["overview"] extends infer Options
  ? Options extends { bootstrap?: infer Callback }
    ? Callback
    : never
  : never;

function makeConfig(serverOverrides: Partial<ResolvedServerConfig> = {}) {
  return makePluginConfig({
    servers: [makeResolvedServerConfig({
      definition: {
        transport: "stdio",
        command: "npx",
      },
      ...serverOverrides,
    })],
  });
}

function createRegistry(
  serverConfigs: readonly ResolvedServerConfig[],
  bootstrap: Bootstrap = vi.fn().mockResolvedValue(undefined),
): McpRegistry {
  return createMcpRegistry(serverConfigs, {
    overview: {
      overviewDir,
      bootstrap,
    },
  });
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("McpRegistry 的 overview ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: [] });
    mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.getServerVersion.mockReturnValue({
      name: "demo",
      version: "1.0.0",
      description: "Demo MCP server",
    });
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("连接成功后由 Registry 内部创建的 bootstrapper 接收描述", async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.connectServer("demo");
    await registry.close();

    expect(bootstrap).toHaveBeenCalledWith({
      config: expect.objectContaining({ name: "demo", hasExplicitOverviewConfig: false }),
      description: "Demo MCP server",
    }, overviewDir);
  });

  it("eager 初始化时触发描述通知", async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig({ connectionMode: "eager" });
    const registry = createRegistry(config.servers, bootstrap);

    await registry.initialize();
    await registry.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("lazy 获取目录时触发描述通知", async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.getServerCatalog("demo");
    await registry.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("lazy 调用工具时触发描述通知", async () => {
    mocks.listTools.mockResolvedValue({
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    });
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.callTool("demo", "search", { query: "pi" });
    await registry.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("保持连接时不重复通知，重连后再次通知", async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.connectServer("demo");
    await registry.connectServer("demo");
    await registry.disconnectServer("demo");
    await Promise.all([
      registry.connectServer("demo"),
      registry.connectServer("demo"),
    ]);
    await registry.close();

    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "  \n  "])("description 为 %j 时不通知", async description => {
    mocks.getServerVersion.mockReturnValue({
      name: "demo",
      version: "1.0.0",
      description,
    });
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.getServerCatalog("demo");
    await registry.close();

    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("Registry close 会等待 overview 写入任务排空", async () => {
    const gate = createDeferred();
    const bootstrap = vi.fn().mockReturnValue(gate.promise);
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.connectServer("demo");
    const closing = registry.close();
    await Promise.resolve();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));

    gate.resolve();
    await closing;
  });

  it("overview 任务失败时不影响连接流程", async () => {
    const bootstrap = vi.fn().mockRejectedValue(new Error("disk full"));
    const config = makeConfig();
    const registry = createRegistry(config.servers, bootstrap);

    await registry.connectServer("demo");
    const server = await registry.getServerSnapshot("demo");
    await registry.close();

    expect(server).toEqual({
      name: "demo",
      connectState: "connected",
      tools: [],
      description: "Demo MCP server",
    });
  });
});
