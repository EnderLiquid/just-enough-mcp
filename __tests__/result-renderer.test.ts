import { describe, expect, it } from "vitest";
import { formatMcpToolCallLines, formatMcpToolResultLines } from "../extensions/rendering/result-renderer.js";

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
  it("collapses long results uniformly with ellipsis", () => {
    const display = formatMcpToolResultLines({
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
    }, false, 4);

    expect(display.lines).toEqual(["line 1", "line 2", "line 3", "line 4", "…"]);
    expect(display.truncated).toBe(true);
  });
});
