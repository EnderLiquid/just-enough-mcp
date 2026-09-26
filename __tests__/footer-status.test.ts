import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFooterStatusSink,
  refreshFooterStatus,
  type FooterStatusSink,
} from "../extensions/rendering/footer-status.js";

const disposers: Array<() => void> = [];

function createTheme(): FooterStatusSink["theme"] {
  return {
    fg: (_color, text) => `<dim>${text}</dim>`,
  };
}

function install(
  setStatus?: (key: string, text: string | undefined) => void,
  theme = createTheme(),
): () => void {
  const dispose = installFooterStatusSink(setStatus ? { setStatus, theme } : undefined);
  disposers.push(dispose);
  return dispose;
}

const status = {
  servers: [],
  connectedCount: 1,
  totalCount: 4,
};

describe("footer 状态", () => {
  afterEach(() => {
    for (const dispose of disposers.splice(0).reverse()) {
      dispose();
    }
  });

  it("更新固定 footer 状态，显示已连接数和总数", () => {
    const setStatus = vi.fn();
    install(setStatus);

    refreshFooterStatus(status);

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "<dim>1/4 MCP</dim>");
  });

  it("未注册 sink 时无操作", () => {
    install();

    expect(() => refreshFooterStatus(status)).not.toThrow();
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

    refreshFooterStatus({ ...status, connectedCount: 2, totalCount: 3 });

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("旧 disposer 不清除替换后的 sink", () => {
    const previousSetStatus = vi.fn();
    const currentSetStatus = vi.fn();
    const disposePrevious = install(previousSetStatus);
    install(currentSetStatus);

    disposePrevious();
    refreshFooterStatus({ ...status, connectedCount: 3, totalCount: 5 });

    expect(previousSetStatus).not.toHaveBeenCalled();
    expect(currentSetStatus).toHaveBeenCalledWith("just-enough-mcp", "<dim>3/5 MCP</dim>");
  });

  it("每次刷新都从当前 theme 取色", () => {
    const setStatus = vi.fn();
    const fg = vi.fn((_color: "dim", text: string) => `first:${text}`);
    install(setStatus, { fg });

    refreshFooterStatus(status);
    fg.mockImplementation((_color, text) => `second:${text}`);
    refreshFooterStatus(status);

    expect(fg).toHaveBeenNthCalledWith(1, "dim", "1/4 MCP");
    expect(fg).toHaveBeenNthCalledWith(2, "dim", "1/4 MCP");
    expect(setStatus).toHaveBeenNthCalledWith(1, "just-enough-mcp", "first:1/4 MCP");
    expect(setStatus).toHaveBeenNthCalledWith(2, "just-enough-mcp", "second:1/4 MCP");
  });

  it("未提供 Registry 状态时清除 footer", () => {
    const setStatus = vi.fn();
    install(setStatus);

    refreshFooterStatus();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });
});
