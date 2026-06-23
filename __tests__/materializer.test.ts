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
  it("returns a single text preview without manifest hint while still writing manifest", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "search",
      result,
    });

    expect(materialized.summaryText).toBe("hello world\n");
    expect(materialized.summaryText).not.toContain("Read manifest for full index");
    expect(existsSync(materialized.manifestPath)).toBe(true);
    expect(existsSync(`${materialized.callDir}/summary.txt`)).toBe(false);
    expect(materialized.metaFiles).toEqual([materialized.manifestPath]);

    const manifest = readFileSync(materialized.manifestPath, "utf8");
    expect(manifest).toContain('"tool": "search"');
    expect(manifest).toContain('"path":');
  });

  it("builds lightweight multi-item summary with file and manifest paths", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [
        { type: "text", text: "hello world" },
        { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
      ],
      structuredContent: { ok: true, count: 2, longText: "abcdefghijklmnopqrstuvwxyz" },
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "search",
      result,
      settings: {
        previewCharsPerItem: 20,
        summaryItemCount: 2,
      },
    });

    expect(existsSync(materialized.manifestPath)).toBe(true);
    expect(existsSync(`${materialized.callDir}/summary.txt`)).toBe(false);
    expect(materialized.payloadItems).toHaveLength(3);
    expect(materialized.summaryText).toContain("[1] text");
    expect(materialized.summaryText).toContain("[2] image");
    expect(materialized.summaryText).toContain("File: ");
    expect(materialized.summaryText).toContain("Read manifest for full index: ");
    expect(materialized.summaryText).toContain("... and 1 more payload items; inspect manifest.json");
    expect(materialized.summaryText).not.toContain("source:");
    expect(materialized.summaryText).not.toContain("mimeType:");
    expect(materialized.payloadItems[2].preview.join("\n")).toContain("Full output: ");

    const manifest = readFileSync(materialized.manifestPath, "utf8");
    expect(manifest).toContain('"kind": "structuredContent"');
    expect(manifest).toContain('"manifestPath":');
  });

  it("suppresses duplicate structuredContent when it is semantically equal to a text payload", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{
        type: "text",
        text: JSON.stringify({
          results: [{ title: "A" }],
          failed_results: [],
          response_time: 0.01,
          request_id: "req-1",
        }),
      }],
      structuredContent: {
        failed_results: [],
        request_id: "req-1",
        response_time: 0.01,
        results: [{ title: "A" }],
      },
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "extract",
      result,
    });

    expect(materialized.payloadItems).toHaveLength(1);
    expect(materialized.mainFiles).toHaveLength(1);
    expect(materialized.payloadItems[0].kind).toBe("text");
    expect(existsSync(`${materialized.callDir}/02-structured.json`)).toBe(false);
    expect(materialized.summaryText).not.toContain("structuredContent");

    const manifest = JSON.parse(readFileSync(materialized.manifestPath, "utf8"));
    expect(manifest.payloadItems).toHaveLength(1);
    expect(manifest.suppressedStructuredContent).toEqual({
      duplicateOf: 1,
      reason: "semantic-json-equal",
    });
  });
});
