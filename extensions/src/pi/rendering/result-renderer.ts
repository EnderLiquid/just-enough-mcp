import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_TUI_RESULT_RENDER_SETTINGS, type McpTuiRenderMode, type TuiResultRenderSettings } from "./types.js";
import {
  formatMcpToolResultLines,
  type McpToolResultDisplay,
} from "./mcp-result.js";
import { pluralize } from "../../core/formatting/english.js";
import type { McpServerResultDetails, McpToolResultDetails } from "../tools/types.js";

export { formatMcpToolResultLines, type McpToolResultDisplay } from "./mcp-result.js";

type RenderTheme = Theme;
type McpResultDetails = McpServerResultDetails | McpToolResultDetails;


export interface McpServerInput {
  action: "status" | "connect" | "disconnect" | "authorize" | "logout";
  server?: string;
}

export interface McpToolInput {
  action: "list" | "call";
  server: string;
  tool?: string;
  args?: Record<string, unknown>;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJson(value: unknown, maxChars: number): string {
  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function emptyText(): Text {
  return new Text("", 0, 0);
}

function renderTitle(
  tool: "mcp_server" | "mcp_tool",
  actionName: string,
  target: string | undefined,
  secondaryTarget: string | undefined,
  theme: RenderTheme,
): string {
  const bold = (value: string) => theme.bold ? theme.bold(value) : value;
  const toolName = theme.fg("toolTitle", bold(tool));
  const action = bold(actionName);
  const accent = target ? theme.fg("accent", target) : undefined;
  const secondary = secondaryTarget ? theme.fg("muted", `@ ${secondaryTarget}`) : undefined;
  return [toolName, action, accent, secondary].filter(Boolean).join(" ");
}

function shouldRenderCallDetails(mode: McpTuiRenderMode, expanded: boolean): boolean {
  if (mode === "hidden") {
    return false;
  }
  return mode === "expanded" || expanded;
}

function shouldRenderExpandedResult(mode: McpTuiRenderMode, expanded: boolean): boolean {
  return mode === "expanded" || (mode === "minimal" && expanded);
}

function formatServerMinimalResultLine(
  details: McpServerResultDetails | undefined,
  isError: boolean,
): string | undefined {
  if (!details) {
    return isError ? "↳ tool failed • Ctrl+O to expand" : "↳ result available • Ctrl+O to expand";
  }
  switch (details.kind) {
    case "status":
      if ("serverName" in details) {
        const oauth = details.oauthState ? `, oauth: ${details.oauthState}` : "";
        return `↳ ${details.serverName}: ${details.connectState}${oauth} • Ctrl+O to expand`;
      }
      return `↳ ${details.connectedCount}/${details.totalCount} ${pluralize(details.totalCount, "server")} connected • Ctrl+O to expand`;
    case "connect":
    case "disconnect":
    case "authorize":
    case "logout":
      return undefined;
    default: {
      const unreachable: never = details;
      return unreachable;
    }
  }
}

function formatToolMinimalResultLine(
  details: McpToolResultDetails | undefined,
  isError: boolean,
): string | undefined {
  if (!details) {
    return isError ? "↳ tool failed • Ctrl+O to expand" : "↳ result available • Ctrl+O to expand";
  }
  switch (details.kind) {
    case "list":
      return `↳ ${details.toolCount} ${pluralize(details.toolCount, "tool")} available • Ctrl+O to expand`;
    case "call": {
      const payloadSummary = `${details.payloadItemCount} ${pluralize(details.payloadItemCount, "payload item")} returned`;
      return isError
        ? `↳ MCP server reported failure • ${payloadSummary} • Ctrl+O to expand`
        : `↳ ${payloadSummary} • Ctrl+O to expand`;
    }
    default: {
      const unreachable: never = details;
      return unreachable;
    }
  }
}

function renderResult<TDetails extends McpResultDetails>(
  result: AgentToolResult<TDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: { isError?: boolean } | undefined,
  formatMinimal: (details: TDetails | undefined, isError: boolean) => string | undefined,
  settings: TuiResultRenderSettings,
): Text {
  const mode = settings.renderMode;
  const isError = context?.isError === true;

  if (mode === "hidden") {
    return emptyText();
  }
  if (options.isPartial) {
    return mode === "minimal"
      ? new Text(theme.fg("muted", "↳ running..."), 0, 0)
      : new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
  }
  if (!shouldRenderExpandedResult(mode, options.expanded)) {
    const line = formatMinimal(result.details, isError);
    return line ? new Text(theme.fg(isError ? "error" : "muted", line), 0, 0) : emptyText();
  }

  const display = formatMcpToolResultLines(result, options.expanded, settings.expandedModeCollapsedLines);
  const output = display.lines.map((line) => {
    if (line === "…" && display.truncated && !options.expanded) {
      return theme.fg("muted", "… (Ctrl+O to expand)");
    }
    return line === "…" ? theme.fg("muted", line) : theme.fg("toolOutput", line);
  }).join("\n");
  return new Text(output, 0, 0);
}

export function createMcpResultRenderer(
  getSettings: () => TuiResultRenderSettings | undefined,
) {
  const settings = () => getSettings() ?? DEFAULT_TUI_RESULT_RENDER_SETTINGS;

  return {
    renderMcpServerCall(
      args: McpServerInput,
      theme: RenderTheme,
      _context?: { expanded?: boolean },
    ): Text {
      return new Text(renderTitle("mcp_server", args.action, args.server, undefined, theme), 0, 0);
    },

    renderMcpToolCall(
      args: McpToolInput,
      theme: RenderTheme,
      context?: { expanded?: boolean },
    ): Text {
      const target = args.action === "call" ? args.tool : args.server;
      const secondary = args.action === "call" ? args.server : undefined;
      const lines = [renderTitle("mcp_tool", args.action, target, secondary, theme)];
      if (
        args.action === "call"
        && args.args !== undefined
        && Object.keys(args.args).length > 0
        && shouldRenderCallDetails(settings().renderMode, context?.expanded ?? false)
      ) {
        lines.push(theme.fg("muted", formatJson(args.args, DEFAULT_MAX_CALL_INPUT_CHARS)));
      }
      return new Text(lines.join("\n"), 0, 0);
    },

    renderMcpServerResult(
      result: AgentToolResult<McpServerResultDetails>,
      options: ToolRenderResultOptions,
      theme: RenderTheme,
      context?: { isError?: boolean },
    ): Text {
      return renderResult(result, options, theme, context, formatServerMinimalResultLine, settings());
    },

    renderMcpToolResult(
      result: AgentToolResult<McpToolResultDetails>,
      options: ToolRenderResultOptions,
      theme: RenderTheme,
      context?: { isError?: boolean },
    ): Text {
      return renderResult(result, options, theme, context, formatToolMinimalResultLine, settings());
    },
  };
}
