import { describe, expect, it, vi } from "vitest";
import { createNotifier } from "../packages/pi-adapter/src/rendering/notifier.js";

describe("notifier 能力", () => {
  it("向显式 sink 发布通知", () => {
    const notify = vi.fn();
    const notifier = createNotifier({ notify });

    notifier.notifyInfo("created");
    notifier.notifyError("failed");

    expect(notify).toHaveBeenNthCalledWith(1, "created", "info");
    expect(notify).toHaveBeenNthCalledWith(2, "failed", "error");
  });

  it("没有 sink 时安全忽略通知", () => {
    const notifier = createNotifier();

    expect(() => notifier.notifyWarning("retry later")).not.toThrow();
  });

  it("吞掉 sink 的通知异常", () => {
    const notify = vi.fn(() => { throw new Error("UI unavailable"); });
    const notifier = createNotifier({ notify });

    expect(() => notifier.notifyWarning("retry later")).not.toThrow();
    expect(notify).toHaveBeenCalledWith("retry later", "warning");
  });

  it("不同 capability 实例之间互不影响", () => {
    const previousNotify = vi.fn();
    const currentNotify = vi.fn();
    const previous = createNotifier({ notify: previousNotify });
    const current = createNotifier({ notify: currentNotify });

    previous.notifyInfo("previous");
    current.notifyError("current");

    expect(previousNotify).toHaveBeenCalledWith("previous", "info");
    expect(currentNotify).toHaveBeenCalledWith("current", "error");
  });
});
