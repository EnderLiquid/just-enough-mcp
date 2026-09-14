import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformBrowserOpener } from "../extensions/oauth/broker/browser-opener.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);
const openedUrls: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  openedUrls.length = 0;
});

/** 假的 child process：只实现 opener 用到的 error/spawn/unref。 */
function fakeChild(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}

function spawnThatEmits(event: "spawn" | "error", payload?: Error) {
  const child = fakeChild();
  mockedSpawn.mockImplementation(() => {
    queueMicrotask(() => (payload ? child.emit(event, payload) : child.emit(event)));
    return child as never;
  });
  return child;
}

describe("createPlatformBrowserOpener", () => {
  it.each([
    { platform: "win32" as const, command: "cmd", args: ["/c", "start", ""] },
    { platform: "darwin" as const, command: "open", args: [] },
    { platform: "linux" as const, command: "xdg-open", args: [] },
  ])("在 $platform 上用 $command 打开授权 URL", async ({ platform, command, args }) => {
    const child = spawnThatEmits("spawn");
    const opener = createPlatformBrowserOpener(platform);

    await expect(opener("https://as.example.test/authorize?x=1")).resolves.toBeUndefined();

    expect(mockedSpawn).toHaveBeenCalledWith(
      command,
      [...args, "https://as.example.test/authorize?x=1"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    // detached 进程不阻塞插件退出。
    expect(child.unref).toHaveBeenCalled();
  });

  it("不支持的平台直接拒绝，且不 spawn", async () => {
    const opener = createPlatformBrowserOpener("freebsd" as NodeJS.Platform);

    await expect(opener("https://as.example.test/authorize")).rejects.toThrow(
      /not supported on platform freebsd/u,
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("spawn 同步抛错时拒绝", async () => {
    mockedSpawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const opener = createPlatformBrowserOpener("linux");

    await expect(opener("https://as.example.test/authorize")).rejects.toThrow("ENOENT");
  });

  it("命令不存在（异步 error 事件）时拒绝，由事务转为 browser-open-failed", async () => {
    spawnThatEmits("error", new Error("spawn xdg-open ENOENT"));
    const opener = createPlatformBrowserOpener("linux");

    await expect(opener("https://as.example.test/authorize")).rejects.toThrow(/ENOENT/u);
  });

  it("spawn 后立刻 unref，不等待浏览器退出", async () => {
    const child = spawnThatEmits("spawn");
    const opener = createPlatformBrowserOpener("win32");

    await opener("https://as.example.test/authorize");
    // 断言 opener 在 spawn 事件后即 resolve，而不是等待子进程 close。
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("close")).toBe(0);
  });
});
