import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { materializeToolCallResult } from "../extensions/artifacts/materializer.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function makeTempDir(): string {
  return join(tmpdir(), `jem-materializer-${randomUUID()}`);
}

describe("materializeToolCallResult", () => {
  it("writes summary, manifest, and payload files", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [
        { type: "text", text: "hello world" },
        { type: "resource", resource: { uri: "file:///report.txt", text: "report body", mimeType: "text/plain" } },
      ],
      structuredContent: { ok: true, count: 2 },
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "search",
      result,
    });

    expect(existsSync(materialized.summaryPath)).toBe(true);
    expect(existsSync(materialized.manifestPath)).toBe(true);
    expect(materialized.payloadItems).toHaveLength(3);
    expect(materialized.summaryText).toContain("MCP result materialized");
    expect(materialized.summaryText).toContain("payload items: 3");

    const manifest = readFileSync(materialized.manifestPath, "utf8");
    expect(manifest).toContain('"tool": "search"');
    expect(manifest).toContain('"kind": "structuredContent"');
  });
});
