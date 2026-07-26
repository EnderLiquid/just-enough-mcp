import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  loadPluginConfig: vi.fn(),
  syncConfig: vi.fn(),
  getStatus: vi.fn(),
  closeAll: vi.fn(),
}));

vi.mock("../extensions/config/plugin-config.js", () => ({
  loadPluginConfig: mocks.loadPluginConfig,
}));

vi.mock("../extensions/servers/registry.js", () => ({
  createServerRegistry: () => ({
    syncConfig: mocks.syncConfig,
    getStatus: mocks.getStatus,
    closeAll: mocks.closeAll,
  }),
}));

import { createRuntime } from "../extensions/servers/runtime.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MCP runtime 生命周期", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncConfig.mockResolvedValue(undefined);
    mocks.getStatus.mockResolvedValue({ servers: [], connectedCount: 0, totalCount: 0 });
    mocks.closeAll.mockResolvedValue(undefined);
  });

  it("等待 closeAll 完成后再同步并提交新配置", async () => {
    const firstConfig = makePluginConfig({
      servers: [makeResolvedServerConfig({ name: "first" })],
    });
    const secondConfig = makePluginConfig({
      servers: [makeResolvedServerConfig({ name: "second" })],
    });
    mocks.loadPluginConfig
      .mockReturnValueOnce(firstConfig)
      .mockReturnValueOnce(secondConfig);
    const runtime = createRuntime();
    await runtime.sync();
    expect(runtime.config()).toBe(firstConfig);

    const closeGate = createDeferred();
    mocks.closeAll.mockImplementationOnce(() => closeGate.promise);
    const closing = runtime.closeAll();
    await vi.waitFor(() => expect(mocks.closeAll).toHaveBeenCalledTimes(1));

    const syncing = runtime.sync();
    await Promise.resolve();
    expect(mocks.loadPluginConfig).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    await closing;
    await syncing;

    expect(mocks.loadPluginConfig).toHaveBeenCalledTimes(2);
    expect(mocks.syncConfig).toHaveBeenLastCalledWith(secondConfig);
    expect(runtime.config()).toBe(secondConfig);
  });
});
