import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { McpTuiRenderMode } from "../extensions/artifacts/types.js";
import {
  formatMcpToolResultLines,
  renderMcpToolCall,
  renderMcpToolResult,
} from "../extensions/rendering/result-renderer.js";

const mocks = vi.hoisted(() => ({
  runtimeConfig: vi.fn(),
}));

vi.mock("../extensions/servers/runtime.js", () => ({
  getMcpRuntime: () => ({
    config: mocks.runtimeConfig,
  }),
}));

const testTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as Theme;

function setRenderMode(renderMode: McpTuiRenderMode, expandedModeCollapsedLines = 4): void {
  mocks.runtimeConfig.mockReturnValue({
    tui: {
      renderMode,
      expandedModeCollapsedLines,
    },
  });
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

describe("renderMcpToolCall", () => {
  it("styles the call title by mcp action and target", () => {
    setRenderMode("minimal");

    const line = renderFirstLine(renderMcpToolCall({
      server: "codegraph",
      tool: "codegraph_explore",
      args: JSON.stringify({ query: "x" }),
    }, testTheme));

    expect(line).toBe("<toolTitle><b>mcp</b></toolTitle> <b>call</b> <accent>codegraph_explore</accent> <muted>@ codegraph</muted>");
  });

  it("hides args in minimal mode until the tool row is expanded", () => {
    setRenderMode("minimal");

    const collapsed = renderMcpToolCall({
      server: "codegraph",
      tool: "codegraph_explore",
      args: JSON.stringify({ query: "x" }),
    }, testTheme, { expanded: false }).render(200).map(line => line.trimEnd());
    const expanded = renderMcpToolCall({
      server: "codegraph",
      tool: "codegraph_explore",
      args: JSON.stringify({ query: "x" }),
    }, testTheme, { expanded: true }).render(200).map(line => line.trimEnd());

    expect(collapsed).toHaveLength(1);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.join("\n")).toContain("query");
  });
});

describe("renderMcpToolResult", () => {
  it("renders nothing in hidden mode", () => {
    setRenderMode("hidden");

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "hello" }],
      details: { kind: "catalog", toolCount: 8 },
    }, { expanded: false, isPartial: false }, testTheme).render(200);

    expect(lines).toEqual([]);
  });

  it("renders minimal catalog, call, and status summaries", () => {
    setRenderMode("minimal");

    const catalog = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "8 tools available:" }],
      details: { kind: "catalog", toolCount: 8 },
    }, { expanded: false, isPartial: false }, testTheme));
    const call = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "payload summary" }],
      details: { kind: "call", payloadItemCount: 2 },
    }, { expanded: false, isPartial: false }, testTheme));
    const status = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "2/5 servers connected:" }],
      details: { kind: "status", connectedCount: 2, totalCount: 5 },
    }, { expanded: false, isPartial: false }, testTheme));

    expect(catalog).toBe("<muted>↳ 8 tools available • Ctrl+O to expand</muted>");
    expect(call).toBe("<muted>↳ 2 payload items returned • Ctrl+O to expand</muted>");
    expect(status).toBe("<muted>↳ 2/5 servers connected • Ctrl+O to expand</muted>");
  });

  it("uses singular nouns in minimal summaries", () => {
    setRenderMode("minimal");

    const catalog = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "1 tool available:" }],
      details: { kind: "catalog", toolCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme));
    const call = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "payload summary" }],
      details: { kind: "call", payloadItemCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme));
    const status = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "1/1 server connected:" }],
      details: { kind: "status", connectedCount: 1, totalCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme));

    expect(catalog).toBe("<muted>↳ 1 tool available • Ctrl+O to expand</muted>");
    expect(call).toBe("<muted>↳ 1 payload item returned • Ctrl+O to expand</muted>");
    expect(status).toBe("<muted>↳ 1/1 server connected • Ctrl+O to expand</muted>");
  });

  it("does not render a minimal connect result", () => {
    setRenderMode("minimal");

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "Connected" }],
      details: { kind: "connect" },
    }, { expanded: false, isPartial: false }, testTheme).render(200);

    expect(lines).toEqual([]);
  });

  it("renders expanded details when minimal mode rows are expanded", () => {
    setRenderMode("minimal");

    const line = renderFirstLine(renderMcpToolResult({
      content: [{ type: "text", text: "line 1\nline 2" }],
      details: { kind: "call", payloadItemCount: 1 },
    }, { expanded: true, isPartial: false }, testTheme));

    expect(line).toBe("<toolOutput>line 1</toolOutput>");
  });

  it("keeps expanded-mode truncation and puts the expand hint on the ellipsis line", () => {
    setRenderMode("expanded", 2);

    const lines = renderMcpToolResult({
      content: [{ type: "text", text: "line 1\nline 2\nline 3" }],
      details: { kind: "call", payloadItemCount: 1 },
    }, { expanded: false, isPartial: false }, testTheme).render(200).map(line => line.trimEnd());

    expect(lines).toEqual([
      "<toolOutput>line 1</toolOutput>",
      "<toolOutput>line 2</toolOutput>",
      "<muted>… (Ctrl+O to expand)</muted>",
    ]);
  });
});
