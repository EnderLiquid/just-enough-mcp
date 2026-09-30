import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  loadPluginConfig: vi.fn(),
  createMcpRegistry: vi.fn(),
  initialize: vi.fn(),
  getStatus: vi.fn(),
  close: vi.fn(),
  createNotifier: vi.fn(),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  createFooterStatusController: vi.fn(),
  disposeFooter: vi.fn(),
  refreshFooterStatus: vi.fn(),
  registerMcpServerTool: vi.fn(),
  registerMcpTool: vi.fn(),
  createServerOverviewPrompt: vi.fn(),
  getAgentDir: vi.fn(),
  getOAuthBrokerDirectoryPath: vi.fn(),
  getArtifactsDirectoryPath: vi.fn(),
  getOverviewDirectoryPath: vi.fn(),
  getPluginConfigPath: vi.fn(),
  getProjectPluginConfigPath: vi.fn(),
  createOAuthBrokerNamespace: vi.fn(),
  oauthBrokerClientConstructor: vi.fn(),
  oauthBrokerClientClose: vi.fn(),
  createOAuthBrokerBootstrapper: vi.fn(),
  oauthBrokerLauncherStart: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: mocks.getAgentDir,
}));

vi.mock("../src/pi/paths.js", () => ({
  getOAuthBrokerDirectoryPath: mocks.getOAuthBrokerDirectoryPath,
  getArtifactsDirectoryPath: mocks.getArtifactsDirectoryPath,
  getOverviewDirectoryPath: mocks.getOverviewDirectoryPath,
  getPluginConfigPath: mocks.getPluginConfigPath,
  getProjectPluginConfigPath: mocks.getProjectPluginConfigPath,
}));

vi.mock("../src/core/oauth/broker/namespace.js", () => ({
  createOAuthBrokerNamespace: mocks.createOAuthBrokerNamespace,
}));

vi.mock("../src/core/oauth/broker/client.js", () => ({
  OAuthBrokerClient: class MockOAuthBrokerClient {
    constructor(options: unknown) {
      mocks.oauthBrokerClientConstructor(options);
    }

    close() {
      return mocks.oauthBrokerClientClose();
    }
  },
}));

vi.mock("../src/core/oauth/broker/bootstrapper.js", () => ({
  createOAuthBrokerBootstrapper: mocks.createOAuthBrokerBootstrapper,
}));

vi.mock("../src/pi/config/plugin-config.js", () => ({
  loadPluginConfigFromPaths: mocks.loadPluginConfig,
}));

vi.mock("../src/pi/rendering/notifier.js", () => ({
  createNotifier: mocks.createNotifier,
}));

vi.mock("../src/pi/rendering/footer-status.js", () => ({
  createFooterStatusController: mocks.createFooterStatusController,
}));

vi.mock("../src/core/servers/registry.js", () => ({
  createMcpRegistry: mocks.createMcpRegistry,
}));

vi.mock("../src/pi/tools/mcp-server-tool.js", () => ({
  registerMcpServerTool: mocks.registerMcpServerTool,
}));

vi.mock("../src/pi/tools/mcp-tool.js", () => ({
  registerMcpTool: mocks.registerMcpTool,
}));

vi.mock("../src/pi/prompting/system-prompt.js", () => ({
  createServerOverviewPrompt: mocks.createServerOverviewPrompt,
}));

import justEnoughMcp from "../src/pi/index.js";

interface FakePi {
  pi: ExtensionAPI;
  handler(eventName: string): (...args: any[]) => any;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    on: vi.fn((eventName: string, handler: (...args: any[]) => any) => {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    }),
  } as unknown as ExtensionAPI;

  return {
    pi,
    handler(eventName) {
      const handler = handlers.get(eventName)?.[0];
      if (!handler) {
        throw new Error(`Missing handler: ${eventName}`);
      }
      return handler;
    },
  };
}

function createContext() {
  return {
    cwd: "C:/workspace",
    isProjectTrusted: vi.fn(() => true),
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
  };
}

function createOauthPluginConfig() {
  return makePluginConfig({
    servers: [makeResolvedServerConfig({
      definition: {
        url: "https://mcp.example.test/rpc",
        auth: "oauth",
        headers: { "x-tenant": "alpha" },
        oauth: { profile: "work", scope: "read write" },
      },
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

function expectCalledBefore(left: ReturnType<typeof vi.fn>, right: ReturnType<typeof vi.fn>): void {
  expect(left.mock.invocationCallOrder[0]).toBeLessThan(right.mock.invocationCallOrder[0]);
}

describe("justEnoughMcp root 生命周期", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const config = makePluginConfig();
    mocks.loadPluginConfig.mockReturnValue(config);
    mocks.initialize.mockResolvedValue({ eagerFailures: [] });
    mocks.getStatus.mockResolvedValue({ servers: [], connectedCount: 0, totalCount: 0 });
    mocks.close.mockResolvedValue(undefined);
    mocks.createMcpRegistry.mockReturnValue({
      initialize: mocks.initialize,
      getStatus: mocks.getStatus,
      close: mocks.close,
    });
    mocks.createNotifier.mockReturnValue({
      notifyInfo: mocks.notifyInfo,
      notifyWarning: mocks.notifyWarning,
      notifyError: mocks.notifyError,
    });
    mocks.createFooterStatusController.mockReturnValue({
      refresh: mocks.refreshFooterStatus,
      dispose: mocks.disposeFooter,
    });
    mocks.refreshFooterStatus.mockResolvedValue(undefined);
    mocks.createServerOverviewPrompt.mockReturnValue("server overviews");
    mocks.getAgentDir.mockReturnValue("C:/Users/Admin/.pi/agent");
    mocks.getPluginConfigPath.mockReturnValue("C:/Users/Admin/.pi/agent/just-enough-mcp/config.json");
    mocks.getProjectPluginConfigPath.mockImplementation((cwd: string) => `${cwd}/.pi/just-enough-mcp/config.json`);
    mocks.getOverviewDirectoryPath.mockReturnValue("C:/Users/Admin/.pi/agent/just-enough-mcp/overviews");
    mocks.getArtifactsDirectoryPath.mockReturnValue("C:/Users/Admin/.pi/agent/just-enough-mcp/artifacts");
    mocks.getOAuthBrokerDirectoryPath.mockReturnValue("C:/Users/Admin/.pi/agent/just-enough-mcp/oauth");
    mocks.createOAuthBrokerNamespace.mockResolvedValue({
      namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
      canonicalAgentDir: "C:/Users/Admin/.pi/agent",
    });
    mocks.oauthBrokerClientClose.mockResolvedValue(undefined);
    mocks.oauthBrokerLauncherStart.mockResolvedValue({});
    mocks.createOAuthBrokerBootstrapper.mockReturnValue({
      start: mocks.oauthBrokerLauncherStart,
    });
  });

  it("factory 阶段只注册工具和生命周期 handler", () => {
    const { pi } = createFakePi();

    justEnoughMcp(pi);

    expect(mocks.registerMcpServerTool).toHaveBeenCalledWith(pi, expect.any(Object));
    expect(mocks.registerMcpTool).toHaveBeenCalledWith(pi, expect.any(Object));
    expect(mocks.loadPluginConfig).not.toHaveBeenCalled();
    expect(mocks.createMcpRegistry).not.toHaveBeenCalled();
    expect(mocks.createFooterStatusController).not.toHaveBeenCalled();
  });

  it("session config adapter 按顺序传入全局和受信项目配置路径", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.loadPluginConfig).toHaveBeenCalledWith(
      [
        "C:/Users/Admin/.pi/agent/just-enough-mcp/config.json",
        "C:/workspace/.pi/just-enough-mcp/config.json",
      ],
      "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews",
      "C:/Users/Admin/.pi/agent/just-enough-mcp/artifacts",
    );

    await handler("session_shutdown")();
  });

  it("未受信项目不会把项目配置路径传给 loader", async () => {
    const { pi, handler } = createFakePi();
    const context = createContext();
    context.isProjectTrusted.mockReturnValue(false);
    justEnoughMcp(pi);

    await handler("session_start")({}, context);

    expect(mocks.loadPluginConfig).toHaveBeenCalledWith(
      ["C:/Users/Admin/.pi/agent/just-enough-mcp/config.json"],
      "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews",
      "C:/Users/Admin/.pi/agent/just-enough-mcp/artifacts",
    );

    await handler("session_shutdown")();
  });

  it("只根据 effective config 决定是否创建 OAuth broker", async () => {
    mocks.loadPluginConfig.mockReturnValue(makePluginConfig({ servers: [] }));
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.oauthBrokerClientConstructor).not.toHaveBeenCalled();
    expect(mocks.createOAuthBrokerBootstrapper).not.toHaveBeenCalled();

    await handler("session_shutdown")();
  });

  it("session start 创建带 overview capability 的 Registry 并完成初始化", async () => {
    const config = makePluginConfig();
    mocks.loadPluginConfig.mockReturnValue(config);
    const { pi, handler } = createFakePi();
    const ctx = createContext();
    justEnoughMcp(pi);

    await handler("session_start")({}, ctx);

    expect(mocks.createMcpRegistry).toHaveBeenCalledWith(config.servers, {
      overview: {
        overviewDir: config.overviewDir,
        onCreated: expect.any(Function),
      },
    });
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.createNotifier).toHaveBeenCalledWith({ notify: expect.any(Function) });
    expect(mocks.createFooterStatusController).toHaveBeenCalledWith(ctx.ui);
    expectCalledBefore(mocks.createMcpRegistry, mocks.initialize);
    expectCalledBefore(mocks.initialize, mocks.refreshFooterStatus);

    const onCreated = mocks.createMcpRegistry.mock.calls[0]?.[1]?.overview?.onCreated;
    onCreated("demo");
    expect(mocks.notifyInfo).toHaveBeenCalledWith("Created MCP overview stub: demo");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("OAuth session 非阻塞启动一个 root-owned broker client，并把借用能力注入 Registry", async () => {
    const config = createOauthPluginConfig();
    const launchGate = createDeferred<unknown>();
    mocks.loadPluginConfig.mockReturnValue(config);
    mocks.oauthBrokerLauncherStart.mockReturnValueOnce(launchGate.promise);
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.getAgentDir).toHaveBeenCalledTimes(1);
    expect(mocks.createOAuthBrokerNamespace).toHaveBeenCalledWith("C:/Users/Admin/.pi/agent");
    expect(mocks.oauthBrokerClientConstructor).toHaveBeenCalledWith({
      rootDir: "C:/Users/Admin/.pi/agent/just-enough-mcp/oauth",
      namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
      configuredPort: 33_418,
    });
    const bootstrapOptions = mocks.createOAuthBrokerBootstrapper.mock.calls[0]?.[0];
    expect(bootstrapOptions).toMatchObject({
      rootDir: "C:/Users/Admin/.pi/agent/just-enough-mcp/oauth",
      namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
      requestedPort: 33_418,
      client: expect.any(Object),
      signal: expect.any(AbortSignal),
      onWarning: expect.any(Function),
    });
    expect(mocks.oauthBrokerLauncherStart).toHaveBeenCalledTimes(1);
    expect(mocks.createMcpRegistry).toHaveBeenCalledWith(config.servers, {
      overview: {
        overviewDir: config.overviewDir,
        onCreated: expect.any(Function),
      },
      oauth: {
        oauthCapability: bootstrapOptions.client,
        namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
      },
    });

    await handler("session_shutdown")();
    expect(bootstrapOptions.signal.aborted).toBe(true);
    expect(mocks.oauthBrokerClientClose).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.oauthBrokerClientClose, mocks.close);
    launchGate.resolve({});
  });

  it("OAuth candidate 初始化失败时关闭 broker client，且不发布 Registry", async () => {
    const config = createOauthPluginConfig();
    mocks.loadPluginConfig.mockReturnValue(config);
    mocks.initialize.mockRejectedValueOnce(new Error("oauth registry failed"));
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    const signal = mocks.createOAuthBrokerBootstrapper.mock.calls[0]?.[0]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(mocks.createMcpRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.oauthBrokerClientClose).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.oauthBrokerClientClose, mocks.close);
  });

  it("footer 初始化失败时保留已提交的 config 和 Registry", async () => {
    mocks.refreshFooterStatus.mockRejectedValueOnce(new Error("footer unavailable"));
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.createFooterStatusController).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: footer unavailable",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenLastCalledWith();
  });

  it("Registry 构造失败时不发布 session 状态", async () => {
    const failure = new Error("invalid server config");
    mocks.createMcpRegistry.mockImplementationOnce(() => { throw failure; });
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.createMcpRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: invalid server config",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenCalledWith();
  });

  it("Registry 初始化意外失败时关闭候选 Registry，不发布 session 状态", async () => {
    const failure = new Error("registry initialization failed");
    mocks.initialize.mockRejectedValueOnce(failure);
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.createMcpRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: registry initialization failed",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenCalledWith();
  });

  it("shutdown 关闭 Registry 后释放 footer capability", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();

    await handler("session_shutdown")();

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.disposeFooter).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.close, mocks.disposeFooter);
  });

  it("shutdown 等待 Registry drain 后才释放 footer capability", async () => {
    const gate = createDeferred();
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();
    mocks.close.mockReturnValueOnce(gate.promise);

    const shuttingDown = handler("session_shutdown")();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.disposeFooter).not.toHaveBeenCalled();

    gate.resolve();
    await shuttingDown;
    expect(mocks.disposeFooter).toHaveBeenCalledTimes(1);
  });

  it("shutdown 可重复调用而不重复关闭 owned resources", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();

    await handler("session_shutdown")();
    await handler("session_shutdown")();

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.disposeFooter).toHaveBeenCalledTimes(1);
  });

  it("未激活时注入 fallback prompt，激活时注入 overview", async () => {
    const config = makePluginConfig();
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    const fallback = await handler("before_agent_start")({ systemPrompt: "base" });
    await handler("session_start")({}, createContext());
    const active = await handler("before_agent_start")({ systemPrompt: "base" });

    expect(fallback.systemPrompt).toContain("has not loaded its configuration");
    expect(active.systemPrompt).toBe("base\n\n# MCP Servers\n\nserver overviews");
    expect(mocks.createServerOverviewPrompt).toHaveBeenCalledWith(config);
  });

  it("已有 MCP Servers 章节时跳过重复注入", async () => {
    const config = makePluginConfig();
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    const result = await handler("before_agent_start")({
      systemPrompt: "parent base\r\n\r\n# MCP Servers\r\n\r\nparent overviews",
    });

    expect(result).toBeUndefined();
    expect(mocks.createServerOverviewPrompt).not.toHaveBeenCalled();
  });

  it("已有 MCP Servers 章节时不注入 fallback", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    const result = await handler("before_agent_start")({
      systemPrompt: "parent base\n\n# MCP Servers\n\nparent overviews",
    });

    expect(result).toBeUndefined();
  });
});
