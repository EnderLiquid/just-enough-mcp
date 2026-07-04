import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getMcpRuntime } from "../servers/runtime.js";
import {
  DEFAULT_RESULT_PRESENTATION_SETTINGS,
  type McpTuiRenderMode,
} from "../artifacts/types.js";
import type { McpToolResultDetails } from "../modeling/types.js";

type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

type RenderTheme = Theme;

export interface McpToolInput {
  connect?: string;
  server?: string;
  tool?: string;
  args?: string;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      return truncateText(JSON.stringify(JSON.parse(value), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function emptyText(): Text {
  return new Text("", 0, 0);
}

function renderCallTitle(args: McpToolInput, theme: RenderTheme): string {
  const toolName = theme.fg("toolTitle", theme.bold ? theme.bold("mcp") : "mcp");
  const accent = (value: string) => theme.fg("accent", value);
  const muted = (value: string) => theme.fg("muted", value);

  if (args.tool) {
    const target = args.server
      ? `${accent(args.tool)} ${muted(`@ ${args.server}`)}`
      : accent(args.tool);
    return `${toolName} ${accent("call")} ${target}`;
  }

  if (args.connect) {
    return `${toolName} ${accent("connect")} ${accent(args.connect)}`;
  }

  if (args.server) {
    return `${toolName} ${accent("list")} ${accent(args.server)}`;
  }

  return `${toolName} ${accent("status")}`;
}

function shouldRenderCallDetails(mode: McpTuiRenderMode, expanded: boolean): boolean {
  if (mode === "hidden") {
    return false;
  }

  return mode === "expanded" || expanded;
}

function renderToolCallLines(args: McpToolInput, theme: RenderTheme, expanded: boolean) {
  const mode = getTuiRenderMode();
  const lines = [renderCallTitle(args, theme)];
  if (shouldRenderCallDetails(mode, expanded) && args.args) {
    lines.push(theme.fg("muted", formatJsonish(args.args, DEFAULT_MAX_CALL_INPUT_CHARS)));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }

  if (block.type === "image") {
    return [`[image: ${block.mimeType}]`];
  }

  return ["[non-text content]"];
}

function getCollapsedPreviewLines(): number {
  return getMcpRuntime().config()?.resultPresentation.collapsedPreviewLines
    ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.collapsedPreviewLines;
}

function getTuiRenderMode(): McpTuiRenderMode {
  return getMcpRuntime().config()?.resultPresentation.tuiRenderMode
    ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.tuiRenderMode;
}

function shouldRenderExpandedResult(mode: McpTuiRenderMode, expanded: boolean): boolean {
  return mode === "expanded" || (mode === "minimal" && expanded);
}

function formatMinimalResultLine(details: McpToolResultDetails | undefined): string | undefined {
  if (!details) {
    return "↳ result available • Ctrl+O to expand";
  }

  switch (details.kind) {
    case "status":
      return `↳ ${details.connectedCount}/${details.totalCount} servers connected • Ctrl+O to expand`;
    case "connect":
      return undefined;
    case "catalog":
      return `↳ ${details.toolCount} tools available • Ctrl+O to expand`;
    case "call":
      return `↳ ${details.payloadItemCount} payload items returned • Ctrl+O to expand`;
    default: {
      const unreachable: never = details;
      return unreachable;
    }
  }
}

export function formatMcpToolCallLines(
  args: McpToolInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.tool) {
    const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args) {
      lines.push(formatJsonish(args.args, maxInputChars));
    }
    return lines;
  }

  if (args.connect) {
    return [`mcp connect ${args.connect}`];
  }

  if (args.server) {
    return [`mcp list ${args.server}`];
  }

  return ["mcp status"];
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = getCollapsedPreviewLines(),
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded) {
    return { lines, truncated: false };
  }

  if (lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}

export function renderMcpToolCall(
  args: McpToolInput,
  theme: RenderTheme,
  context?: { expanded?: boolean },
) {
  return renderToolCallLines(args, theme, context?.expanded ?? false);
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
) {
  const mode = getTuiRenderMode();

  if (mode === "hidden") {
    return emptyText();
  }

  if (options.isPartial) {
    return mode === "minimal"
      ? new Text(theme.fg("muted", "↳ running..."), 0, 0)
      : new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  if (!shouldRenderExpandedResult(mode, options.expanded)) {
    const line = formatMinimalResultLine(result.details);
    return line ? new Text(theme.fg("muted", line), 0, 0) : emptyText();
  }

  const display = formatMcpToolResultLines(result, options.expanded);
  const output = display.lines
    .map((line) => {
      if (line === "…" && display.truncated && !options.expanded) {
        return theme.fg("muted", "… (Ctrl+O to expand)");
      }
      return line === "…"
        ? theme.fg("muted", line)
        : theme.fg("toolOutput", line);
    })
    .join("\n");

  return new Text(output, 0, 0);
}
