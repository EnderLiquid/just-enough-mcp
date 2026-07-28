import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOverviewBootstrapper,
  installCurrentOverviewBootstrapper,
  notifyServerDescriptionReady,
  type OverviewBootstrapper,
} from "../extensions/config/overview-bootstrapper.js";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const serverConfig = makeResolvedServerConfig({ name: "demo" });
const event = {
  config: serverConfig,
  description: "Demo MCP server",
};

let bootstrapper: OverviewBootstrapper | undefined;
let disposeBootstrapper: (() => void) | undefined;

afterEach(async () => {
  disposeBootstrapper?.();
  await bootstrapper?.close();
  disposeBootstrapper = undefined;
  bootstrapper = undefined;
});

describe("OverviewBootstrapper", () => {
  it("使用构造时捕获的 overviewDir，并仅在创建成功时通知", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ created: true, path: "demo.md" });
    const onCreated = vi.fn();
    bootstrapper = createOverviewBootstrapper({
      overviewDir: "D:/overviews",
      bootstrap,
      onCreated,
    });

    bootstrapper.notify(event);
    await bootstrapper.close();

    expect(bootstrap).toHaveBeenCalledWith(event, "D:/overviews");
    expect(onCreated).toHaveBeenCalledWith("demo");
  });

  it("notify 立即返回，close 等待 pending task", async () => {
    const gate = createDeferred<{ created: boolean; path: string }>();
    const bootstrap = vi.fn().mockReturnValue(gate.promise);
    bootstrapper = createOverviewBootstrapper({ overviewDir: "D:/overviews", bootstrap });

    expect(bootstrapper.notify(event)).toBeUndefined();
    const closing = bootstrapper.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);

    gate.resolve({ created: true, path: "demo.md" });
    await closing;
    expect(closed).toBe(true);
  });

  it("任务失败被隔离，close 幂等且关闭后忽略新事件", async () => {
    const bootstrap = vi.fn().mockRejectedValue(new Error("disk full"));
    bootstrapper = createOverviewBootstrapper({ overviewDir: "D:/overviews", bootstrap });

    bootstrapper.notify(event);
    const firstClose = bootstrapper.close();
    const secondClose = bootstrapper.close();
    await expect(firstClose).resolves.toBeUndefined();
    await expect(secondClose).resolves.toBeUndefined();

    bootstrapper.notify(event);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("空白 description 不入队", async () => {
    const bootstrap = vi.fn();
    bootstrapper = createOverviewBootstrapper({ overviewDir: "D:/overviews", bootstrap });

    bootstrapper.notify({ ...event, description: "  \n " });
    await bootstrapper.close();

    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("旧 disposer 不清除替换后的 Bootstrapper", () => {
    const first = { notify: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const second = { notify: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const disposeFirst = installCurrentOverviewBootstrapper(first);
    disposeBootstrapper = installCurrentOverviewBootstrapper(second);
    bootstrapper = second;

    disposeFirst();
    notifyServerDescriptionReady(event);

    expect(first.notify).not.toHaveBeenCalled();
    expect(second.notify).toHaveBeenCalledWith(event);
  });
});
