import { describe, expect, it } from "vitest";
import { formatMcpToolCallLines, formatMcpToolResultLines } from "../extensions/rendering/result-renderer.js";
import type { McpToolResultDetails } from "../extensions/modeling/types.js";

describe("formatMcpToolCallLines", () => {
  it("formats call input with server and args", () => {
    const lines = formatMcpToolCallLines({
      server: "tavily",
      tool: "search",
      args: JSON.stringify({ query: "pi mcp" }),
    });

    expect(lines[0]).toBe("mcp call search @ tavily");
    expect(lines[1]).toContain("query");
  });
});

describe("formatMcpToolResultLines", () => {
  it("collapses materialized results into a compact preview", () => {
    const details: McpToolResultDetails = {
      stage: "runtime-call-tool",
      materialized: true,
      callDir: ".pi/mcp-artifacts/x",
      summaryPath: ".pi/mcp-artifacts/x/summary.txt",
      manifestPath: ".pi/mcp-artifacts/x/manifest.json",
      mainFiles: ["a.txt", "b.json"],
      metaFiles: ["summary.txt", "manifest.json"],
      summaryTruncated: false,
      payloadItems: [
        {
          index: 1,
          kind: "text",
          source: "content[0]",
          path: "a.txt",
          relativePath: "a.txt",
          fileName: "01-text.txt",
          preview: ["hello world"],
        },
      ],
      servers: [],
    };

    const display = formatMcpToolResultLines({
      content: [{ type: "text", text: "full summary here" }],
      details,
    }, false, 4);

    expect(display.lines[0]).toContain("MCP result materialized");
    expect(display.lines[1]).toContain("01-text.txt");
    expect(display.lines.at(-1)).toBe("… expand to view full summary");
    expect(display.truncated).toBe(true);
  });
});
