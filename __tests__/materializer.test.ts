import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtifactTransactionCleanupError,
  createArtifactContext,
  rollbackArtifactContext,
} from "../extensions/artifacts/artifact-store.js";
import { materializeToolCallResult } from "../extensions/artifacts/materializer.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-materializer");

describe("materializeToolCallResult", () => {
  afterEach(() => {
    vi.useRealTimers();
    tempDirs.cleanup();
  });

  it("保留合法服务器名作为调用目录前缀", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T04:18:22Z"));

    const cwd = tempDirs.create();
    const serverName = `${"a".repeat(29)}--b`;
    const result: CallToolResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: serverName,
      tool: "codegraph_explore",
      result,
    });

    const callDirName = materialized.callDir.split("/").pop();
    expect(callDirName).toMatch(new RegExp(`^${serverName}-260623-041822-[0-9a-f]{32}$`));
    expect(callDirName).not.toContain("codegraph_explore");
    expect(readdirSync(`${cwd}/.pi/mcp`)).toEqual([callDirName]);
  });

  it("移除自身 staging 目录，不影响无关的 partial 目录", () => {
    const cwd = tempDirs.create();
    const artifactRoot = `${cwd}/.pi/mcp`;
    mkdirSync(`${artifactRoot}/.partial-existing`, { recursive: true });
    const context = createArtifactContext({
      cwd,
      server: "demo",
      settings: { artifactRoot: ".pi/mcp" },
    });
    writeFileSync(`${context.stagingDir}/01-text.txt`, "partial", "utf8");

    rollbackArtifactContext(context);

    expect(readdirSync(artifactRoot)).toEqual([".partial-existing"]);
  });

  it("staging 清理失败时仍保留物化错误信息", () => {
    const cwd = tempDirs.create();
    const materializationError = new Error("payload write failed");
    const context = createArtifactContext({
      cwd,
      server: "demo",
      settings: { artifactRoot: ".pi/mcp" },
    });
    rmSync(context.stagingDir, { recursive: true });
    writeFileSync(context.stagingDir, "not a directory", "utf8");
    let cleanupError: unknown;

    try {
      rollbackArtifactContext(context);
    } catch (error) {
      cleanupError = error;
    }
    const combinedError = new ArtifactTransactionCleanupError(
      materializationError,
      cleanupError,
      context.stagingDir,
    );

    expect(combinedError).toMatchObject({
      cause: materializationError,
      materializationError,
      cleanupError,
      stagingDir: context.stagingDir,
    });
    expect(combinedError.message).toContain("payload write failed");
    expect(combinedError.message).toContain("additionally failed to clean staging directory");
  });

  it("仅返回单条文本预览（不含 manifest 提示），但实际仍写入 manifest", () => {
    const cwd = tempDirs.create();
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
    expect(manifest).not.toContain(".partial-");
    expect(materialized.summaryText).not.toContain(".partial-");
  });

  it("识别 JSON 文本，标记为 application/json，写入 .json 文件", () => {
    const cwd = tempDirs.create();
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

  it("标记行内截断，报告剩余字符数和行数", () => {
    const cwd = tempDirs.create();
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
    expect(materialized.summaryText).toContain("16 more chars across 1 line of remaining text");
    expect(materialized.summaryText).toContain("Full output: ");
  });

  it("截断摘要中使用英文单数形式", () => {
    const cwd = tempDirs.create();
    const result: CallToolResult = {
      content: [{ type: "text", text: "abcde" }],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "demo",
      tool: "preview-singular",
      result,
      settings: {
        previewFullCharsPerItem: 4,
        previewTruncateToCharsPerItem: 4,
      },
    });

    expect(materialized.summaryText).toContain("1 more char across 1 line of remaining text");
  });

  it("截断发生在行边界时在新行显示截断摘要", () => {
    const cwd = tempDirs.create();
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

  it("使用 MIME registry 推导扩展名，并将未知类型物化为 bin 文件", () => {
    const cwd = tempDirs.create();
    const result: CallToolResult = {
      content: [
        { type: "image", mimeType: "image/svg+xml", data: Buffer.from("svg").toString("base64") },
        { type: "audio", mimeType: "audio/mpeg", data: Buffer.from("mp3").toString("base64") },
        {
          type: "resource",
          resource: {
            uri: "https://example.com/guide",
            mimeType: "text/markdown; charset=utf-8",
            text: "# Guide",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "https://example.com/report",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            blob: Buffer.from("docx").toString("base64"),
          },
        },
        {
          type: "resource",
          resource: {
            uri: "https://example.com/mystery",
            mimeType: "application/x-example",
            blob: Buffer.from("unknown").toString("base64"),
          },
        },
      ],
      isError: false,
    };

    const materialized = materializeToolCallResult({
      cwd,
      server: "demo",
      tool: "mime-examples",
      result,
    });

    expect(materialized.payloadItems.map(item => item.fileName)).toEqual([
      "01-image.svg",
      "02-audio.mp3",
      "03-guide.md",
      "04-report.docx",
      "05-mystery.bin",
    ]);
  });

  it("构建轻量多条目摘要，包含文件和 manifest 路径", () => {
    const cwd = tempDirs.create();
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
    expect(materialized.summaryText).toContain("… and 1 more payload item; inspect manifest.json");
    expect(materialized.summaryText).not.toContain("source:");
    expect(materialized.summaryText).not.toContain("mimeType:");
    expect(materialized.payloadItems[2]?.preview?.join("\n")).toContain("⟦TRUNCATED⟧");
    expect(materialized.payloadItems[2]?.preview?.join("\n")).toContain("Full output: ");

    const manifest = readFileSync(materialized.manifestPath, "utf8");
    expect(manifest).toContain('"source": "structuredContent"');
    expect(manifest).toContain('"mimeType": "application/json"');
    expect(manifest).toContain('"manifestPath":');
  });

  it("使用 4 字符哈希后缀缩短过长的资源文件名", () => {
    const cwd = tempDirs.create();
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

  it("将 resource_link 物化为纯文本，同时在 rawMimeType 中保留目标 MIME 类型", () => {
    const cwd = tempDirs.create();
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

  it("当 structuredContent 与文本 payload 语义相等时抑制重复", () => {
    const cwd = tempDirs.create();
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
