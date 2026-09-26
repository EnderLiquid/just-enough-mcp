import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  loadPluginConfig: vi.fn(),
  createServerRegistry: vi.fn(),
  initialize: vi.fn(),
  getStatus: vi.fn(),
  closeAll: vi.fn(),
  overviewBootstrapperConstructor: vi.fn(),
  overviewBootstrapperClose: vi.fn(),
  installCurrentPluginConfig: vi.fn(),
  getCurrentPluginConfig: vi.fn(),
  disposeConfig: vi.fn(),
  installCurrentServerRegistry: vi.fn(),
  disposeRegistry: vi.fn(),
  installNotifierSink: vi.fn(),
  disposeNotifier: vi.fn(),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  installFooterStatusSink: vi.fn(),
  disposeFooter: vi.fn(),
  refreshFooterStatus: vi.fn(),
  registerMcpServerTool: vi.fn(),
  registerMcpTool: vi.fn(),
  createServerOverviewPrompt: vi.fn(),
  getAgentDir: vi.fn(),
  getOAuthBrokerDirectoryPath: vi.fn(),
  createOAuthBrokerNamespace: vi.fn(),
  oauthBrokerClientConstructor: vi.fn(),
  oauthBrokerClientClose: vi.fn(),
  createOAuthBrokerBootstrapper: vi.fn(),
  oauthBrokerLauncherStart: vi.fn(),
  notifyWarning: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: mocks.getAgentDir,
}));

vi.mock("../extensions/config/paths.js", () => ({
  getOAuthBrokerDirectoryPath: mocks.getOAuthBrokerDirectoryPath,
}));

vi.mock("../extensions/oauth/broker/namespace.js", () => ({
  createOAuthBrokerNamespace: mocks.createOAuthBrokerNamespace,
}));

vi.mock("../extensions/oauth/broker/client.js", () => ({
  OAuthBrokerClient: class MockOAuthBrokerClient {
    constructor(options: unknown) {
      mocks.oauthBrokerClientConstructor(options);
    }

    close() {
      return mocks.oauthBrokerClientClose();
    }
  },
}));

vi.mock("../extensions/oauth/broker/bootstrapper.js", () => ({
  createOAuthBrokerBootstrapper: mocks.createOAuthBrokerBootstrapper,
}));

vi.mock("../extensions/config/plugin-config.js", () => ({
  loadPluginConfig: mocks.loadPluginConfig,
}));

vi.mock("../extensions/config/current-config.js", () => ({
  getCurrentPluginConfig: mocks.getCurrentPluginConfig,
  installCurrentPluginConfig: mocks.installCurrentPluginConfig,
}));

vi.mock("../extensions/config/overview-bootstrapper.js", () => ({
  OverviewBootstrapper: class MockOverviewBootstrapper {
    constructor(options: unknown) {
      return mocks.overviewBootstrapperConstructor(options);
    }
  },
}));

vi.mock("../extensions/servers/current-registry.js", () => ({
  installCurrentServerRegistry: mocks.installCurrentServerRegistry,
}));

vi.mock("../extensions/servers/registry.js", () => ({
  createServerRegistry: mocks.createServerRegistry,
}));

vi.mock("../extensions/rendering/notifier.js", () => ({
  installNotifierSink: mocks.installNotifierSink,
  notifyInfo: mocks.notifyInfo,
  notifyError: mocks.notifyError,
  notifyWarning: mocks.notifyWarning,
}));

vi.mock("../extensions/rendering/footer-status.js", () => ({
  installFooterStatusSink: mocks.installFooterStatusSink,
  refreshFooterStatus: mocks.refreshFooterStatus,
}));

vi.mock("../extensions/tools/mcp-server-tool.js", () => ({
  registerMcpServerTool: mocks.registerMcpServerTool,
}));

vi.mock("../extensions/tools/mcp-tool.js", () => ({
  registerMcpTool: mocks.registerMcpTool,
}));

vi.mock("../extensions/prompting/system-prompt.js", () => ({
  createServerOverviewPrompt: mocks.createServerOverviewPrompt,
}));

import justEnoughMcp from "../extensions/just-enough-mcp.js";

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
    mocks.initialize.mockResolvedValue(undefined);
    mocks.getStatus.mockResolvedValue({ servers: [], connectedCount: 0, totalCount: 0 });
    mocks.closeAll.mockResolvedValue(undefined);
    mocks.overviewBootstrapperClose.mockResolvedValue(undefined);
    mocks.createServerRegistry.mockReturnValue({
      initialize: mocks.initialize,
      getStatus: mocks.getStatus,
      closeAll: mocks.closeAll,
    });
    mocks.overviewBootstrapperConstructor.mockReturnValue({
      notify: vi.fn(),
      close: mocks.overviewBootstrapperClose,
    });
    mocks.installCurrentPluginConfig.mockReturnValue(mocks.disposeConfig);
    mocks.installCurrentServerRegistry.mockReturnValue(mocks.disposeRegistry);
    mocks.installNotifierSink.mockReturnValue(mocks.disposeNotifier);
    mocks.installFooterStatusSink.mockReturnValue(mocks.disposeFooter);
    mocks.refreshFooterStatus.mockResolvedValue(undefined);
    mocks.createServerOverviewPrompt.mockReturnValue("server overviews");
    mocks.getAgentDir.mockReturnValue("C:/Users/Admin/.pi/agent");
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

    expect(mocks.registerMcpServerTool).toHaveBeenCalledWith(pi);
    expect(mocks.registerMcpTool).toHaveBeenCalledWith(pi);
    expect(mocks.loadPluginConfig).not.toHaveBeenCalled();
    expect(mocks.createServerRegistry).not.toHaveBeenCalled();
    expect(mocks.overviewBootstrapperConstructor).not.toHaveBeenCalled();
  });

  it("session start 先创建 overviewBootstrapper 并初始化 Registry，再发布 config 和 Registry", async () => {
    const config = makePluginConfig();
    mocks.loadPluginConfig.mockReturnValue(config);
    const { pi, handler } = createFakePi();
    const ctx = createContext();
    justEnoughMcp(pi);

    await handler("session_start")({}, ctx);

    expect(mocks.overviewBootstrapperConstructor).toHaveBeenCalledWith({
      overviewDir: config.overviewDir,
      onCreated: expect.any(Function),
    });
    expect(mocks.createServerRegistry).toHaveBeenCalledWith(
      config.servers,
      {
        overviewBootstrapper: mocks.overviewBootstrapperConstructor.mock.results[0]?.value,
      },
    );
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.installCurrentPluginConfig).toHaveBeenCalledWith(config);
    expect(mocks.installCurrentServerRegistry).toHaveBeenCalledWith(
      mocks.createServerRegistry.mock.results[0]?.value,
    );
    expect(mocks.installFooterStatusSink).toHaveBeenCalledWith(ctx.ui);
    expectCalledBefore(mocks.overviewBootstrapperConstructor, mocks.createServerRegistry);
    expectCalledBefore(mocks.createServerRegistry, mocks.initialize);
    expectCalledBefore(mocks.initialize, mocks.installCurrentPluginConfig);
    expectCalledBefore(mocks.initialize, mocks.installCurrentServerRegistry);
    expectCalledBefore(mocks.installCurrentServerRegistry, mocks.refreshFooterStatus);

    const onCreated = mocks.overviewBootstrapperConstructor.mock.calls[0]?.[0]?.onCreated;
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
    expect(mocks.createServerRegistry).toHaveBeenCalledWith(config.servers, {
      overviewBootstrapper: mocks.overviewBootstrapperConstructor.mock.results[0]?.value,
      oauth: {
        brokerClient: bootstrapOptions.client,
        namespaceId: `agent-dir:v1:${"d".repeat(64)}`,
      },
    });
    expect(mocks.installCurrentServerRegistry).toHaveBeenCalledTimes(1);

    await handler("session_shutdown")();
    expect(bootstrapOptions.signal.aborted).toBe(true);
    expect(mocks.oauthBrokerClientClose).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.disposeRegistry, mocks.oauthBrokerClientClose);
    expectCalledBefore(mocks.oauthBrokerClientClose, mocks.closeAll);
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
    expect(mocks.installCurrentServerRegistry).not.toHaveBeenCalled();
    expect(mocks.oauthBrokerClientClose).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.oauthBrokerClientClose, mocks.closeAll);
  });

  it("footer 初始化失败时保留已提交的 config 和 Registry", async () => {
    mocks.refreshFooterStatus.mockRejectedValueOnce(new Error("footer unavailable"));
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.installCurrentPluginConfig).toHaveBeenCalledTimes(1);
    expect(mocks.installCurrentServerRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.overviewBootstrapperClose).not.toHaveBeenCalled();
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: footer unavailable",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenLastCalledWith();
  });

  it("Registry 构造失败时只关闭候选 overviewBootstrapper，不发布 current 状态", async () => {
    const failure = new Error("invalid server config");
    mocks.createServerRegistry.mockImplementationOnce(() => { throw failure; });
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.installCurrentPluginConfig).not.toHaveBeenCalled();
    expect(mocks.installCurrentServerRegistry).not.toHaveBeenCalled();
    expect(mocks.closeAll).not.toHaveBeenCalled();
    expect(mocks.overviewBootstrapperClose).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: invalid server config",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenCalledWith();
  });

  it("Registry 初始化意外失败时关闭候选资源，不发布 current 状态", async () => {
    const failure = new Error("registry initialization failed");
    mocks.initialize.mockRejectedValueOnce(failure);
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);

    await handler("session_start")({}, createContext());

    expect(mocks.installCurrentPluginConfig).not.toHaveBeenCalled();
    expect(mocks.installCurrentServerRegistry).not.toHaveBeenCalled();
    expect(mocks.closeAll).toHaveBeenCalledTimes(1);
    expect(mocks.overviewBootstrapperClose).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.closeAll, mocks.overviewBootstrapperClose);
    expect(mocks.notifyError).toHaveBeenCalledWith(
      "just-enough-mcp config error: registry initialization failed",
    );
    expect(mocks.refreshFooterStatus).toHaveBeenCalledWith();
  });

  it("shutdown 先撤销并关闭 Registry，再排空 overviewBootstrapper，最后释放 Pi sinks", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();

    await handler("session_shutdown")();

    expect(mocks.disposeRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.disposeConfig).toHaveBeenCalledTimes(1);
    expect(mocks.closeAll).toHaveBeenCalledTimes(1);
    expect(mocks.overviewBootstrapperClose).toHaveBeenCalledTimes(1);
    expect(mocks.disposeFooter).toHaveBeenCalledTimes(1);
    expect(mocks.disposeNotifier).toHaveBeenCalledTimes(1);
    expectCalledBefore(mocks.disposeRegistry, mocks.closeAll);
    expectCalledBefore(mocks.closeAll, mocks.overviewBootstrapperClose);
    expectCalledBefore(mocks.overviewBootstrapperClose, mocks.disposeFooter);
    expectCalledBefore(mocks.disposeFooter, mocks.disposeNotifier);
  });

  it("shutdown 等待 Bootstrapper 排空后才释放 Pi sinks", async () => {
    const gate = createDeferred();
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();
    mocks.overviewBootstrapperClose.mockReturnValueOnce(gate.promise);

    const shuttingDown = handler("session_shutdown")();
    await vi.waitFor(() => expect(mocks.overviewBootstrapperClose).toHaveBeenCalledTimes(1));
    expect(mocks.disposeFooter).not.toHaveBeenCalled();
    expect(mocks.disposeNotifier).not.toHaveBeenCalled();

    gate.resolve();
    await shuttingDown;
    expect(mocks.disposeFooter).toHaveBeenCalledTimes(1);
    expect(mocks.disposeNotifier).toHaveBeenCalledTimes(1);
  });

  it("shutdown 可重复调用而不重复关闭 owned resources", async () => {
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    await handler("session_start")({}, createContext());
    vi.clearAllMocks();

    await handler("session_shutdown")();
    await handler("session_shutdown")();

    expect(mocks.closeAll).toHaveBeenCalledTimes(1);
    expect(mocks.overviewBootstrapperClose).toHaveBeenCalledTimes(1);
  });

  it("未激活时注入 fallback prompt，激活时注入 overview", async () => {
    const config = makePluginConfig();
    const { pi, handler } = createFakePi();
    justEnoughMcp(pi);
    mocks.getCurrentPluginConfig.mockReturnValueOnce(undefined).mockReturnValueOnce(config);

    const fallback = await handler("before_agent_start")({ systemPrompt: "base" });
    const active = await handler("before_agent_start")({ systemPrompt: "base" });

    expect(fallback.systemPrompt).toContain("has not loaded its configuration");
    expect(active.systemPrompt).toBe("base\n\n# MCP Servers\n\nserver overviews");
    expect(mocks.createServerOverviewPrompt).toHaveBeenCalledWith(config);
  });
});
