import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMcpRuntime } from "../servers/runtime.js";
import { DEFAULT_RESULT_PRESENTATION_SETTINGS } from "../modeling/materialization.js";

type McpToolContentBlock = AgentToolResult<undefined>["content"][number];

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

function renderToolCallLines(lines: string[], theme: RenderTheme) {
  const [title = "mcp", ...rest] = lines;
  const styledTitle = theme.fg("toolTitle", theme.bold ? theme.bold(title) : title);
  const styledRest = rest.map(line => theme.fg("muted", line));
  return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
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
  result: Pick<AgentToolResult<undefined>, "content">,
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

export function renderMcpToolCall(args: McpToolInput, theme: RenderTheme) {
  return renderToolCallLines(formatMcpToolCallLines(args), theme);
}

export function renderMcpToolResult(
  result: AgentToolResult<undefined>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const display = formatMcpToolResultLines(result, options.expanded);
  const output = display.lines
    .map((line) => line === "…"
      ? theme.fg("muted", line)
      : theme.fg("toolOutput", line))
    .join("\n");
  const hint = display.truncated && !options.expanded
    ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
    : "";

  return new Text(`${output}${hint}`, 0, 0);
}
