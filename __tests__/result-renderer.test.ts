import { afterEach, describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TUI_RESULT_RENDER_SETTINGS,
  type McpTuiRenderMode,
  type TuiResultRenderSettings,
} from "../extensions/src/pi/rendering/types.js";
import {
  createMcpResultRenderer,
  formatMcpToolResultLines,
} from "../extensions/src/pi/rendering/result-renderer.js";

const testTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as Theme;

let renderSettings: TuiResultRenderSettings = DEFAULT_TUI_RESULT_RENDER_SETTINGS;
const {
  renderMcpServerCall,
  renderMcpServerResult,
  renderMcpToolCall,
  renderMcpToolResult,
} = createMcpResultRenderer(() => renderSettings);

function setRenderMode(renderMode: McpTuiRenderMode, expandedModeCollapsedLines = 4): void {
  renderSettings = { renderMode, expandedModeCollapsedLines };
}

function renderFirstLine(component: { render(width: number): string[] }): string | undefined {
  return component.render(200)[0]?.trimEnd();
}

afterEach(() => {
  renderSettings = DEFAULT_TUI_RESULT_RENDER_SETTINGS;
});

describe("formatMcpToolResultLines", () => {
  it("对长结果统一使用省略号折叠", () => {
    const display = formatMcpToolResultLines({
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
    }, false, 4);

    expect(display.lines).toEqual(["line 1", "line 2", "line 3", "line 4", "…"]);
    expect(display.truncated).toBe(true);
  });
});

describe("MCP 调用渲染器", () => {
  it("直接根据 action 渲染服务器操作", () => {
    setRenderMode("minimal");

    expect(renderFirstLine(renderMcpServerCall({ action: "status" }, testTheme))).toBe(
      "<toolTitle><b>mcp_server</b></toolTitle> <b>status</b>",
    );
    expect(renderFirstLine(renderMcpServerCall({
      action: "status",
      server: "context7",
    }, testTheme))).toBe(
      "<toolTitle><b>mcp_server</b></toolTitle> <b>status</b> <accent>context7</accent>",
    );
    expect(renderFirstLine(renderMcpServerCall({
      action: "disconnect",
      server: "context7",
    }, testTheme))).toBe(
      "<toolTitle><b>mcp_server</b></toolTitle> <b>disconnect</b> <accent>context7</accent>",
    );
  });

  it("渲染工具列表和调用目标", () => {
    setRenderMode("minimal");

    expect(renderFirstLine(renderMcpToolCall({
      action: "list",
      server: "codegraph",
    }, testTheme))).toBe(
      "<toolTitle><b>mcp_tool</b></toolTitle> <b>list</b> <accent>codegraph</accent>",
    );
    expect(renderFirstLine(renderMcpToolCall({
      action: "call",
      server: "codegraph",
      tool: "codegraph_explore",
      args: { query: "x" },
    }, testTheme))).toBe(
      "<toolTitle><b>mcp_tool</b></toolTitle> <b>call</b> <accent>codegraph_explore</accent> <muted>@ codegraph</muted>",
    );
  });

  it("展开时仅显示非空调用参数", () => {
    setRenderMode("minimal");

    const collapsed = renderMcpToolCall({
      action: "call",
      server: "codegraph",
      tool: "codegraph_explore",
      args: { query: "x" },
    }, testTheme, { expanded: false }).render(200).map(line => line.trimEnd());
    const expanded = renderMcpToolCall({
      action: "call",
      server: "codegraph",
      tool: "codegraph_explore",
      args: { query: "x" },
    }, testTheme, { expanded: true }).render(200).map(line => line.trimEnd());
    const empty = renderMcpToolCall({
      action: "call",
      server: "codegraph",
      tool: "ping",
      args: {},
    }, testTheme, { expanded: true }).render(200);

    expect(collapsed).toHaveLength(1);
    expect(expanded.join("\n")).toContain("query");
    expect(empty).toHaveLength(1);
  });
});

describe("MCP 结果渲染器", () => {
  it("hidden 模式下不渲染任何内容", () => {
    setRenderMode("hidden");

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "hello" }],
      details: { kind: "list", toolCount: 8 },
    }, { expanded: false, isPartial: false }, testTheme).render(200);

    expect(lines).toEqual([]);
  });

  it("渲染最小化工具和服务器状态摘要", () => {
    setRenderMode("minimal");

    const catalog = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "8 tools available:" }],
      details: { kind: "list", toolCount: 8 },
    }, { expanded: false, isPartial: false }, testTheme));
    const call = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "payload summary" }],
      details: { kind: "call", payloadItemCount: 2, outcome: "success" },
    }, { expanded: false, isPartial: false }, testTheme));
    const servers = renderFirstLine(renderMcpServerResult({
      content: [{ type: "text", text: "2/5 servers connected:" }],
      details: { kind: "status", connectedCount: 2, totalCount: 5 },
    }, { expanded: false, isPartial: false }, testTheme));

    expect(catalog).toBe("<muted>↳ 8 tools available • Ctrl+O to expand</muted>");
    expect(call).toBe("<muted>↳ 2 payload items returned • Ctrl+O to expand</muted>");
    expect(servers).toBe("<muted>↳ 2/5 servers connected • Ctrl+O to expand</muted>");
  });

  it("从最终工具上下文渲染失败的 MCP 调用", () => {
    setRenderMode("minimal");

    const call = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "remote tool failed" }],
      details: { kind: "call", payloadItemCount: 2, outcome: "error" },
    }, { expanded: false, isPartial: false }, testTheme, { isError: true }));

    expect(call).toBe("<error>↳ MCP server reported failure • 2 payload items returned • Ctrl+O to expand</error>");
  });

  it("使用英文单数名词", () => {
    setRenderMode("minimal");

    const catalog = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "1 tool available:" }],
      details: { kind: "list", toolCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme));
    const servers = renderFirstLine(renderMcpServerResult({
      content: [{ type: "text", text: "1/1 server connected:" }],
      details: { kind: "status", connectedCount: 1, totalCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme));

    expect(catalog).toBe("<muted>↳ 1 tool available • Ctrl+O to expand</muted>");
    expect(servers).toBe("<muted>↳ 1/1 server connected • Ctrl+O to expand</muted>");

    const server = renderFirstLine(renderMcpServerResult({
      content: [{ type: "text", text: "context7\nconnected" }],
      details: { kind: "status", serverName: "context7", connectState: "connected" },
    }, { expanded: false, isPartial: false }, testTheme));
    expect(server).toBe("<muted>↳ context7: connected • Ctrl+O to expand</muted>");
  });

  it("不渲染最小化的 connect/disconnect 结果", () => {
    setRenderMode("minimal");

    const connect = renderMcpServerResult({
      content: [{ type: "text", text: "Connected" }],
      details: { kind: "connect" },
    }, { expanded: false, isPartial: false }, testTheme).render(200);
    const disconnect = renderMcpServerResult({
      content: [{ type: "text", text: "Disconnected" }],
      details: { kind: "disconnect" },
    }, { expanded: false, isPartial: false }, testTheme).render(200);

    expect(connect).toEqual([]);
    expect(disconnect).toEqual([]);
  });

  it("渲染展开的详细内容和截断提示", () => {
    setRenderMode("expanded", 2);

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "line 1\nline 2\nline 3" }],
      details: { kind: "call", payloadItemCount: 1, outcome: "success" },
    }, { expanded: false, isPartial: false }, testTheme).render(200).map(line => line.trimEnd());

    expect(lines).toEqual([
      "<toolOutput>line 1</toolOutput>",
      "<toolOutput>line 2</toolOutput>",
      "<muted>… (Ctrl+O to expand)</muted>",
    ]);
  });
});
