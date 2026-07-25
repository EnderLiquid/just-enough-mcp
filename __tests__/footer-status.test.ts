import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFooterStatus,
  setFooterStatusSink,
  updateFooterStatus,
} from "../extensions/rendering/footer-status.js";

describe("footer 状态", () => {
  afterEach(() => {
    clearFooterStatus();
  });

  it("更新固定 footer 状态，显示已连接数和总数", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });

    updateFooterStatus(1, 4);

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "1/4 MCP");
  });

  it("未注册 sink 时无操作", () => {
    setFooterStatusSink(undefined);

    expect(() => updateFooterStatus(1, 4)).not.toThrow();
    expect(() => clearFooterStatus()).not.toThrow();
  });

  it("清除后移除 footer 状态", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });

    clearFooterStatus();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("清除后释放 sink 引用", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });
    clearFooterStatus();

    updateFooterStatus(2, 3);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("仅向替换后的 sink 发布更新", () => {
    const previousSetStatus = vi.fn();
    const currentSetStatus = vi.fn();
    setFooterStatusSink({ setStatus: previousSetStatus });
    setFooterStatusSink({ setStatus: currentSetStatus });

    updateFooterStatus(3, 5);

    expect(previousSetStatus).not.toHaveBeenCalled();
    expect(currentSetStatus).toHaveBeenCalledWith("just-enough-mcp", "3/5 MCP");
  });
});
