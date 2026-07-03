import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeToolCallResult } from "../extensions/artifacts/materializer.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function makeTempDir(): string {
  return join(tmpdir(), `jem-materializer-${randomUUID()}`);
}

describe("materializeToolCallResult", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a shorter call directory name based on server and compact UTC timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T04:18:22Z"));

    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "codegraph",
      tool: "codegraph_explore",
      result,
    });

    const callDirName = materialized.callDir.split("/").pop();
    expect(callDirName).toMatch(/^codegraph-260623-041822-[0-9a-f]{4}$/);
    expect(callDirName).not.toContain("codegraph_explore");
  });

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

  it("detects JSON text, assigns application/json, and writes a .json file", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{ type: "text", text: '{"ok":true,"count":2}' }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "search",
      result,
    });

    expect(materialized.payloadItems).toHaveLength(1);
    expect(materialized.payloadItems[0]?.mimeType).toBe("application/json");
    expect(materialized.payloadItems[0]?.rawMimeType).toBe("text/plain");
    expect(materialized.payloadItems[0]?.fileName).toBe("01-json.json");
    expect(materialized.summaryText).toContain('"ok": true');
  });

  it("marks in-line truncation and reports remaining chars and lines", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "demo",
      tool: "preview",
      result,
      settings: {
        previewFullCharsPerItem: 20,
        previewTruncateToCharsPerItem: 10,
      },
    });

    expect(materialized.summaryText).toContain("abcdefghij… ⟦TRUNCATED⟧");
    expect(materialized.summaryText).toContain("16 more chars across 1 lines of remaining text");
    expect(materialized.summaryText).toContain("Full output: ");
  });

  it("shows truncation summary on a new line when truncation happens at a line boundary", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{ type: "text", text: "abc\ndef\nghi" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "demo",
      tool: "preview-lines",
      result,
      settings: {
        previewFullCharsPerItem: 7,
        previewTruncateToCharsPerItem: 3,
      },
    });

    expect(materialized.summaryText).toContain("abc\n… 8 more chars across 2 lines of remaining text");
    expect(materialized.summaryText).not.toContain("⟦TRUNCATED⟧");
    expect(materialized.summaryText).toContain("Full output: ");
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
        previewFullCharsPerItem: 30,
        previewTruncateToCharsPerItem: 20,
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
    expect(materialized.summaryText).toContain("… and 1 more payload items; inspect manifest.json");
    expect(materialized.summaryText).not.toContain("source:");
    expect(materialized.summaryText).not.toContain("mimeType:");
    expect(materialized.payloadItems[2]?.preview?.join("\n")).toContain("⟦TRUNCATED⟧");
    expect(materialized.payloadItems[2]?.preview?.join("\n")).toContain("Full output: ");

    const manifest = readFileSync(materialized.manifestPath, "utf8");
    expect(manifest).toContain('"source": "structuredContent"');
    expect(manifest).toContain('"mimeType": "application/json"');
    expect(manifest).toContain('"manifestPath":');
  });

  it("shortens long resource basenames with a 4-character hash suffix", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{
        type: "resource",
        resource: {
          uri: "https://example.com/abcdeabcdeabcdeabcdeabcdeabcdeabcdeabcde.txt",
          mimeType: "text/plain",
          text: "resource body",
        },
      }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "tavily",
      tool: "extract",
      result,
    });

    expect(materialized.payloadItems).toHaveLength(1);
    expect(materialized.payloadItems[0]?.fileName).toMatch(/^01-abcdeabcdeabcdeabcdeabcdeabcdeab-[a-z0-9]{4}\.txt$/);
    expect(existsSync(materialized.payloadItems[0]!.path!)).toBe(true);
  });

  it("materializes resource_link as text while preserving target mime type in rawMimeType", () => {
    const cwd = makeTempDir();
    const result: CallToolResult = {
      content: [{
        type: "resource_link",
        uri: "https://example.com/report",
        name: "report",
        mimeType: "application/pdf",
        description: "Quarterly report",
      }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "demo",
      tool: "links",
      result,
    });

    expect(materialized.payloadItems).toHaveLength(1);
    expect(materialized.payloadItems[0]?.contentType).toBe("resource_link");
    expect(materialized.payloadItems[0]?.mimeType).toBe("text/plain");
    expect(materialized.payloadItems[0]?.rawMimeType).toBe("application/pdf");
    expect(materialized.payloadItems[0]?.fileName).toBe("01-link.txt");
    expect(materialized.summaryText).toContain("URI: https://example.com/report");
    expect(materialized.summaryText).toContain("Description: Quarterly report");
    expect(materialized.summaryText).toContain("Target MIME type: application/pdf");
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
    expect(materialized.payloadItems[0]?.contentType).toBe("text");
    expect(materialized.payloadItems[0]?.mimeType).toBe("application/json");
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
