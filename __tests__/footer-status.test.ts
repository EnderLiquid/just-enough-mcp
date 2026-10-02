import { describe, expect, it, vi } from "vitest";
import {
  createFooterStatusController,
  type FooterStatusSink,
} from "../packages/pi-adapter/src/rendering/footer-status.js";

function createTheme(): FooterStatusSink["theme"] {
  return {
    fg: (_color, text) => `<dim>${text}</dim>`,
  };
}

const status = {
  servers: [],
  connectedCount: 1,
  totalCount: 4,
};

describe("footer 状态 capability", () => {
  it("更新固定 footer 状态，显示已连接数和总数", () => {
    const setStatus = vi.fn();
    const footer = createFooterStatusController({ setStatus, theme: createTheme() });

    footer.refresh(status);

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "<dim>1/4 MCP</dim>");
  });

  it("未提供 sink 时无操作", () => {
    const footer = createFooterStatusController();

    expect(() => footer.refresh(status)).not.toThrow();
  });

  it("释放 capability 时清除插件 footer 状态", () => {
    const setStatus = vi.fn();
    const footer = createFooterStatusController({ setStatus, theme: createTheme() });

    footer.dispose();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("释放后不再向旧 sink 发布更新", () => {
    const setStatus = vi.fn();
    const footer = createFooterStatusController({ setStatus, theme: createTheme() });
    footer.dispose();

    footer.refresh({ ...status, connectedCount: 2, totalCount: 3 });

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("不同 capability 实例之间互不影响", () => {
    const previousSetStatus = vi.fn();
    const currentSetStatus = vi.fn();
    const previous = createFooterStatusController({ setStatus: previousSetStatus, theme: createTheme() });
    const current = createFooterStatusController({ setStatus: currentSetStatus, theme: createTheme() });

    previous.dispose();
    current.refresh({ ...status, connectedCount: 3, totalCount: 5 });

    expect(previousSetStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
    expect(currentSetStatus).toHaveBeenCalledWith("just-enough-mcp", "<dim>3/5 MCP</dim>");
  });

  it("每次刷新都从当前 theme 取色", () => {
    const setStatus = vi.fn();
    const fg = vi.fn((_color: "dim", text: string) => `first:${text}`);
    const footer = createFooterStatusController({ setStatus, theme: { fg } });

    footer.refresh(status);
    fg.mockImplementation((_color, text) => `second:${text}`);
    footer.refresh(status);

    expect(fg).toHaveBeenNthCalledWith(1, "dim", "1/4 MCP");
    expect(fg).toHaveBeenNthCalledWith(2, "dim", "1/4 MCP");
    expect(setStatus).toHaveBeenNthCalledWith(1, "just-enough-mcp", "first:1/4 MCP");
    expect(setStatus).toHaveBeenNthCalledWith(2, "just-enough-mcp", "second:1/4 MCP");
  });

  it("未提供 Registry 状态时清除 footer", () => {
    const setStatus = vi.fn();
    const footer = createFooterStatusController({ setStatus, theme: createTheme() });

    footer.refresh();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });
});
