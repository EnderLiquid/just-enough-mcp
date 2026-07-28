import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFooterStatusSink,
  refreshFooterStatus,
  updateFooterStatus,
} from "../extensions/rendering/footer-status.js";

const disposers: Array<() => void> = [];

function install(setStatus?: (key: string, text: string | undefined) => void): () => void {
  const dispose = installFooterStatusSink(setStatus ? { setStatus } : undefined);
  disposers.push(dispose);
  return dispose;
}

describe("footer 状态", () => {
  afterEach(() => {
    for (const dispose of disposers.splice(0).reverse()) {
      dispose();
    }
  });

  it("更新固定 footer 状态，显示已连接数和总数", () => {
    const setStatus = vi.fn();
    install(setStatus);

    updateFooterStatus(1, 4);

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "1/4 MCP");
  });

  it("未注册 sink 时无操作", () => {
    install();

    expect(() => updateFooterStatus(1, 4)).not.toThrow();
  });

  it("释放引用时清除插件 footer 状态", () => {
    const setStatus = vi.fn();
    const dispose = install(setStatus);

    dispose();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("释放后不再向旧 sink 发布更新", () => {
    const setStatus = vi.fn();
    const dispose = install(setStatus);
    dispose();

    updateFooterStatus(2, 3);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("旧 disposer 不清除替换后的 sink", () => {
    const previousSetStatus = vi.fn();
    const currentSetStatus = vi.fn();
    const disposePrevious = install(previousSetStatus);
    install(currentSetStatus);

    disposePrevious();
    updateFooterStatus(3, 5);

    expect(previousSetStatus).not.toHaveBeenCalled();
    expect(currentSetStatus).toHaveBeenCalledWith("just-enough-mcp", "3/5 MCP");
  });

  it("从 Registry 状态刷新 footer", async () => {
    const setStatus = vi.fn();
    install(setStatus);
    const getStatus = vi.fn().mockResolvedValue({
      servers: [],
      connectedCount: 2,
      totalCount: 6,
    });

    await refreshFooterStatus({ getStatus });

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "2/6 MCP");
  });
});
