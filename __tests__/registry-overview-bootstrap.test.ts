import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOverviewBootstrapper,
  installCurrentOverviewBootstrapper,
  type OverviewBootstrapper,
  type OverviewBootstrapperOptions,
} from "../extensions/config/overview-bootstrapper.js";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
import { createServerRegistry } from "../extensions/servers/registry.js";
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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let currentBootstrapper: OverviewBootstrapper | undefined;
let disposeBootstrapper: (() => void) | undefined;

function useBootstrapper(
  bootstrap: NonNullable<OverviewBootstrapperOptions["bootstrap"]> = vi.fn().mockResolvedValue(undefined),
): { bootstrapper: OverviewBootstrapper; bootstrap: typeof bootstrap } {
  currentBootstrapper = createOverviewBootstrapper({
    overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
    bootstrap,
  });
  disposeBootstrapper = installCurrentOverviewBootstrapper(currentBootstrapper);
  return { bootstrapper: currentBootstrapper, bootstrap };
}

describe("Server description ready overview 通知", () => {
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

  afterEach(async () => {
    disposeBootstrapper?.();
    await currentBootstrapper?.close();
    disposeBootstrapper = undefined;
    currentBootstrapper = undefined;
  });

  it("首次成功初始化时向当前 Bootstrapper 入队描述", async () => {
    const { bootstrapper, bootstrap } = useBootstrapper();
    const config = makeConfig();
    const registry = createServerRegistry();

    await registry.syncConfig(config);
    await registry.connectServer("demo");
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledWith({
      config: expect.objectContaining({ name: "demo", hasExplicitOverviewConfig: false }),
      description: "Demo MCP server",
    }, config.overviewDir);
  });

  it("eager 初始化时触发描述通知", async () => {
    const { bootstrapper, bootstrap } = useBootstrapper();
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig({ connectionMode: "eager" }));
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("lazy 获取目录时触发描述通知", async () => {
    const { bootstrapper, bootstrap } = useBootstrapper();
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.getServerCatalog("demo");
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("lazy 调用工具时触发描述通知", async () => {
    mocks.listTools.mockResolvedValue({
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    });
    const { bootstrapper, bootstrap } = useBootstrapper();
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.callTool("demo", "search", { query: "pi" });
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("保持连接时不重复通知，重连后再次通知", async () => {
    const { bootstrapper, bootstrap } = useBootstrapper();
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");
    await registry.connectServer("demo");
    await registry.disconnectServer("demo");
    await Promise.all([
      registry.connectServer("demo"),
      registry.connectServer("demo"),
    ]);
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "  \n  "])("description 为 %j 时不通知", async description => {
    mocks.getServerVersion.mockReturnValue({
      name: "demo",
      version: "1.0.0",
      description,
    });
    const { bootstrapper, bootstrap } = useBootstrapper();
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.getServerCatalog("demo");
    await bootstrapper.close();

    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("overview 写入未完成时连接已经返回", async () => {
    const gate = createDeferred();
    const { bootstrapper, bootstrap } = useBootstrapper(vi.fn().mockReturnValue(gate.promise));
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig());

    await registry.connectServer("demo");

    expect(bootstrap).toHaveBeenCalledTimes(1);
    const server = await registry.getServerSnapshot("demo");
    expect(server?.connectState).toBe("connected");

    gate.resolve();
    await bootstrapper.close();
  });

  it("同步通知异常时不回滚已经建立的连接", async () => {
    currentBootstrapper = {
      notify: vi.fn(() => { throw new Error("observer failed"); }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    disposeBootstrapper = installCurrentOverviewBootstrapper(currentBootstrapper);
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");

    const server = await registry.getServerSnapshot("demo");
    expect(server?.connectState).toBe("connected");
  });

  it("overview 任务失败时不影响连接流程", async () => {
    const { bootstrapper } = useBootstrapper(vi.fn().mockRejectedValue(new Error("disk full")));
    const registry = createServerRegistry();

    await registry.syncConfig(makeConfig());
    await registry.connectServer("demo");
    await bootstrapper.close();

    const server = await registry.getServerSnapshot("demo");
    expect(server).toEqual({
      name: "demo",
      connectState: "connected",
      tools: [],
      description: "Demo MCP server",
    });
  });
});
