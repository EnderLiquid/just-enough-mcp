import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { McpTuiRenderMode } from "../extensions/artifacts/types.js";
import {
  formatMcpToolResultLines,
  renderMcpServerCall,
  renderMcpServerResult,
  renderMcpToolCall,
  renderMcpToolResult,
} from "../extensions/rendering/result-renderer.js";

const mocks = vi.hoisted(() => ({ runtimeConfig: vi.fn() }));

vi.mock("../extensions/servers/runtime.js", () => ({
  getMcpRuntime: () => ({ config: mocks.runtimeConfig }),
}));

const testTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as Theme;

function setRenderMode(renderMode: McpTuiRenderMode, expandedModeCollapsedLines = 4): void {
  mocks.runtimeConfig.mockReturnValue({ tui: { renderMode, expandedModeCollapsedLines } });
}

function renderFirstLine(component: { render(width: number): string[] }): string | undefined {
  return component.render(200)[0]?.trimEnd();
}

beforeEach(() => {
  mocks.runtimeConfig.mockReset();
});

describe("formatMcpToolResultLines", () => {
  it("collapses long results uniformly with ellipsis", () => {
    const display = formatMcpToolResultLines({
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
    }, false, 4);

    expect(display.lines).toEqual(["line 1", "line 2", "line 3", "line 4", "…"]);
    expect(display.truncated).toBe(true);
  });
});

describe("MCP call renderers", () => {
  it("renders server actions directly from action", () => {
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

  it("renders tool list and call targets", () => {
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

  it("shows only non-empty call args when expanded", () => {
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

describe("MCP result renderers", () => {
  it("renders nothing in hidden mode", () => {
    setRenderMode("hidden");

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "hello" }],
      details: { kind: "list", toolCount: 8 },
    }, { expanded: false, isPartial: false }, testTheme).render(200);

    expect(lines).toEqual([]);
  });

  it("renders minimal tool and server status summaries", () => {
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

  it("renders failed MCP calls from the final tool context", () => {
    setRenderMode("minimal");

    const call = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "remote tool failed" }],
      details: { kind: "call", payloadItemCount: 2, outcome: "error" },
    }, { expanded: false, isPartial: false }, testTheme, { isError: true }));

    expect(call).toBe("<error>↳ MCP server reported failure • 2 payload items returned • Ctrl+O to expand</error>");
  });

  it("uses singular nouns", () => {
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

  it("does not render minimal connect or disconnect results", () => {
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

  it("renders expanded details and truncation hints", () => {
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
