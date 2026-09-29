import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_TUI_RESULT_RENDER_SETTINGS } from "../artifacts/types.js";

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

type McpContentBlock = CallToolResult["content"][number];

function blockToLines(block: McpContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  if (block.type === "image") {
    return [`[image: ${block.mimeType}]`];
  }
  return ["[non-text content]"];
}

export function formatMcpToolResultLines(
  result: Pick<CallToolResult, "content">,
  expanded: boolean,
  maxCollapsedLines = DEFAULT_TUI_RESULT_RENDER_SETTINGS.expandedModeCollapsedLines,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded || lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}
