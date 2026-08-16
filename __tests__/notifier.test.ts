import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installNotifierSink,
  notifyError,
  notifyInfo,
  notifyWarning,
} from "../extensions/rendering/notifier.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
});

describe("notifier borrowed sink", () => {
  it("向当前 sink 发布通知并在释放后停止使用", () => {
    const notify = vi.fn();
    const dispose = installNotifierSink({ notify });
    disposers.push(dispose);

    notifyInfo("created");
    dispose();
    notifyError("late error");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("created", "info");
  });

  it("吞掉 sink 的通知异常", () => {
    const notify = vi.fn(() => { throw new Error("UI unavailable"); });
    disposers.push(installNotifierSink({ notify }));

    expect(() => notifyWarning("retry later")).not.toThrow();
    expect(notify).toHaveBeenCalledWith("retry later", "warning");
  });

  it("旧 disposer 不清除替换后的 sink", () => {
    const previousNotify = vi.fn();
    const currentNotify = vi.fn();
    const disposePrevious = installNotifierSink({ notify: previousNotify });
    disposers.push(disposePrevious);
    const disposeCurrent = installNotifierSink({ notify: currentNotify });
    disposers.push(disposeCurrent);

    disposePrevious();
    notifyError("failed");

    expect(previousNotify).not.toHaveBeenCalled();
    expect(currentNotify).toHaveBeenCalledWith("failed", "error");
  });
});
