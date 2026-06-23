import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MATERIALIZATION_SETTINGS,
  type MaterializedToolCallResult,
  type MaterializationSettings,
  type PayloadItem,
  type PayloadItemIndex,
  type SummaryBudget,
} from "../modeling/materialization.js";

interface TextPreviewResult {
  lines: string[];
  truncated: boolean;
}

interface SuppressedStructuredContent {
  duplicateOf: number;
  reason: "semantic-json-equal" | "exact-text-equal";
}

interface ExtractedPayloadItemsResult {
  items: PayloadItem[];
  suppressedStructuredContent?: SuppressedStructuredContent;
}

function isEmbeddedTextResource(resource: unknown): resource is { uri: string; text: string; mimeType?: string } {
  return typeof resource === "object" && resource !== null && "text" in resource && typeof (resource as { text?: unknown }).text === "string";
}

function isEmbeddedBlobResource(resource: unknown): resource is { uri: string; blob: string; mimeType?: string } {
  return typeof resource === "object" && resource !== null && "blob" in resource && typeof (resource as { blob?: unknown }).blob === "string";
}

function isResourceLink(content: unknown): content is { uri: string; mimeType?: string; description?: string; type: "resource_link" } {
  return typeof content === "object"
    && content !== null
    && "type" in content
    && (content as { type?: unknown }).type === "resource_link"
    && "uri" in content
    && typeof (content as { uri?: unknown }).uri === "string";
}

export interface MaterializeCallToolResultInput {
  cwd?: string;
  server: string;
  tool: string;
  result: CallToolResult;
  settings?: Partial<MaterializationSettings>;
}

function sanitizeSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "artifact";
}

function toCompactUtcTimestamp(date = new Date()): string {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function createCallDirectoryName(server: string): string {
  const target = sanitizeSegment(server).slice(0, 32);
  const suffix = randomBytes(2).toString("hex");
  return `${target}-${toCompactUtcTimestamp()}-${suffix}`;
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveArtifactRoot(cwd: string, artifactRoot: string): string {
  return isAbsolute(artifactRoot) ? artifactRoot : resolve(cwd, artifactRoot);
}

function inferExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  const mapping: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "text/csv": ".csv",
  };

  if (mapping[normalized]) {
    return mapping[normalized];
  }

  const subtype = normalized.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) return ".bin";
  if (subtype === "jpeg") return ".jpg";
  return `.${subtype.replace(/[^A-Za-z0-9]+/g, "") || "bin"}`;
}

function inferBaseNameFromUri(uri?: string): string | undefined {
  if (!uri) return undefined;

  try {
    const parsed = new URL(uri);
    return basename(parsed.pathname) || undefined;
  } catch {
    return basename(uri) || undefined;
  }
}

function toShortHash(value: string): string {
  const digest = createHash("sha1").update(value).digest();
  const encoded = digest.readUInt32BE(0).toString(36);
  return encoded.padStart(4, "0").slice(0, 4);
}

function shortenNormalizedBase(value: string): string {
  if (value.length <= 32) {
    return value;
  }

  return `${value.slice(0, 32)}-${toShortHash(value)}`;
}

function normalizeJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function buildTextPreview(text: string, maxLines: number, maxChars: number): TextPreviewResult {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) {
    return { lines: ["(empty text)"], truncated: false };
  }

  let truncated = false;
  let clipped = normalized;

  if (clipped.length > maxChars) {
    clipped = clipped.slice(0, Math.max(0, maxChars));
    truncated = true;
  }

  let lines = clipped.split("\n");
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }

  if (truncated) {
    lines.push("…");
  }

  return { lines, truncated };
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isTextualPayload(item: PayloadItem): boolean {
  return typeof item.text === "string";
}

function isJsonTextualPayload(item: PayloadItem): boolean {
  return isTextualPayload(item) && item.mimeType === "application/json" && item.parsedJson !== undefined;
}

function withRawMimeType(item: PayloadItem, rawMimeType: string | undefined): PayloadItem {
  if (!rawMimeType || rawMimeType === item.mimeType) {
    return item;
  }

  return {
    ...item,
    rawMimeType,
  };
}

function normalizeTextPayload(item: PayloadItem, prettyPrintJson: boolean): PayloadItem {
  const rawText = item.text ?? "";
  const parsedJson = tryParseJson(rawText);
  if (parsedJson === undefined) {
    return {
      ...item,
      mimeType: item.mimeType || "text/plain",
      text: ensureTrailingNewline(rawText),
    };
  }

  const text = prettyPrintJson
    ? normalizeJsonText(parsedJson)
    : ensureTrailingNewline(rawText);

  return withRawMimeType({
    ...item,
    mimeType: "application/json",
    text,
    parsedJson,
  }, item.mimeType);
}

function buildResourceLinkText(uri: string, description?: string, rawMimeType?: string): string {
  const lines = [`URI: ${uri}`];
  if (description) {
    lines.push(`Description: ${description}`);
  }
  if (rawMimeType) {
    lines.push(`Target MIME type: ${rawMimeType}`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeStructuredContent(value: Record<string, unknown>): PayloadItem {
  return {
    source: "structuredContent",
    mimeType: "application/json",
    text: normalizeJsonText(value),
    parsedJson: value,
  };
}

function findSuppressedStructuredContent(
  structuredItem: PayloadItem,
  items: PayloadItem[],
): SuppressedStructuredContent | undefined {
  if (structuredItem.parsedJson === undefined) {
    return undefined;
  }

  for (const [index, item] of items.entries()) {
    if (!isJsonTextualPayload(item)) {
      continue;
    }

    if (isDeepStrictEqual(item.parsedJson, structuredItem.parsedJson)) {
      return {
        duplicateOf: index + 1,
        reason: "semantic-json-equal",
      };
    }

    if (item.text?.trimEnd() === structuredItem.text?.trimEnd()) {
      return {
        duplicateOf: index + 1,
        reason: "exact-text-equal",
      };
    }
  }

  return undefined;
}

function extractPayloadItems(result: CallToolResult, settings: MaterializationSettings): ExtractedPayloadItemsResult {
  const items: PayloadItem[] = [];

  for (const [index, content] of (result.content ?? []).entries()) {
    const source = `content[${index}]`;

    if (content.type === "text") {
      items.push(normalizeTextPayload({
        source,
        contentType: "text",
        mimeType: "text/plain",
        text: content.text ?? "",
      }, settings.prettyPrintJson));
      continue;
    }

    if (content.type === "image") {
      items.push({
        source,
        contentType: "image",
        mimeType: content.mimeType ?? "application/octet-stream",
        binaryBase64: content.data ?? "",
      });
      continue;
    }

    if (content.type === "audio") {
      items.push({
        source,
        contentType: "audio",
        mimeType: content.mimeType ?? "application/octet-stream",
        binaryBase64: content.data ?? "",
      });
      continue;
    }

    if (isResourceLink(content)) {
      const rawMimeType = content.mimeType;
      items.push(withRawMimeType({
        source,
        contentType: "resource_link",
        mimeType: "text/plain",
        uri: content.uri,
        description: content.description,
        text: buildResourceLinkText(content.uri, content.description, rawMimeType),
      }, rawMimeType));
      continue;
    }

    if (content.type === "resource") {
      if (isEmbeddedTextResource(content.resource)) {
        items.push(normalizeTextPayload({
          source,
          contentType: "resource",
          mimeType: content.resource.mimeType ?? "text/plain",
          uri: content.resource.uri,
          text: content.resource.text,
        }, settings.prettyPrintJson));
        continue;
      }

      if (isEmbeddedBlobResource(content.resource)) {
        items.push({
          source,
          contentType: "resource",
          mimeType: content.resource.mimeType ?? "application/octet-stream",
          uri: content.resource.uri,
          binaryBase64: content.resource.blob,
        });
        continue;
      }
    }

    items.push(normalizeTextPayload({
      source,
      contentType: "unknown",
      mimeType: "text/plain",
      text: JSON.stringify(content, null, 2),
    }, settings.prettyPrintJson));
  }

  let suppressedStructuredContent: SuppressedStructuredContent | undefined;

  if (result.structuredContent && typeof result.structuredContent === "object") {
    const structuredItem = normalizeStructuredContent(result.structuredContent as Record<string, unknown>);
    suppressedStructuredContent = findSuppressedStructuredContent(structuredItem, items);

    if (!suppressedStructuredContent) {
      items.push(structuredItem);
    }
  }

  return {
    items,
    suppressedStructuredContent,
  };
}

function buildDefaultStem(item: PayloadItem): string {
  if (item.source === "structuredContent") {
    return "structured";
  }

  if (item.contentType === "resource_link") {
    return "link";
  }

  if (item.mimeType === "application/json") {
    return "json";
  }

  switch (item.contentType) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "resource":
      return "resource";
    case "unknown":
    default:
      return "unknown";
  }
}

function buildMainFileName(index: number, item: PayloadItem): string {
  const prefix = String(index).padStart(2, "0");
  let stem = buildDefaultStem(item);

  if (item.source !== "structuredContent" && item.contentType !== "resource_link") {
    const baseName = inferBaseNameFromUri(item.uri);
    if (baseName) {
      stem = shortenNormalizedBase(sanitizeSegment(baseName.replace(extname(baseName), "")));
    }
  }

  const ext = inferExtensionFromMimeType(item.mimeType);
  return `${prefix}-${stem}${ext}`;
}

function writePayloadMainFile(filePath: string, item: PayloadItem): string | undefined {
  if (item.binaryBase64 !== undefined) {
    const binary = Buffer.from(item.binaryBase64, "base64");
    writeFileSync(filePath, binary);
    return undefined;
  }

  const text = ensureTrailingNewline(item.text ?? "");
  writeFileSync(filePath, text, "utf8");
  return text;
}

function buildItemPreview(item: PayloadItem, absolutePath: string, storedText: string | undefined, settings: MaterializationSettings): string[] {
  if (storedText === undefined) {
    return [`File: ${absolutePath}`];
  }

  const preview = buildTextPreview(storedText, settings.previewLinesPerItem, settings.previewCharsPerItem);
  if (!preview.truncated) {
    return preview.lines;
  }

  return [...preview.lines, `Full output: ${absolutePath}`];
}

function toDisplayLabel(item: PayloadItem): string {
  if (item.source === "structuredContent") {
    return "structuredContent";
  }

  return item.contentType ?? "unknown";
}

function joinSections(sections: string[][]): string {
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

function buildSummary(payloadItems: PayloadItem[], manifestPath: string, budget: SummaryBudget): string {
  if (payloadItems.length === 0) {
    return "(empty result)\n";
  }

  if (payloadItems.length === 1) {
    return `${(payloadItems[0].preview ?? []).join("\n")}\n`;
  }

  const sections: string[][] = [];
  const displayedItems = payloadItems.slice(0, budget.summaryItemCount);

  for (const item of displayedItems) {
    sections.push([`[${item.index}] ${toDisplayLabel(item)}`, ...(item.preview ?? [])]);
  }

  if (payloadItems.length > displayedItems.length) {
    sections.push([`... and ${payloadItems.length - displayedItems.length} more payload items; inspect manifest.json`]);
  }

  sections.push([`Read manifest for full index: ${manifestPath}`]);
  return joinSections(sections);
}

function applyHardMax(summaryText: string, hardMaxChars: number, manifestPath: string): string {
  if (summaryText.length <= hardMaxChars) {
    return summaryText;
  }

  const tail = `\n\n…\nHard output limit reached; inspect manifest: ${manifestPath}\n`;
  const budget = Math.max(0, hardMaxChars - tail.length);
  return `${summaryText.slice(0, budget).trimEnd()}${tail}`;
}

function toPayloadItemIndex(item: PayloadItem): PayloadItemIndex {
  return {
    index: item.index!,
    source: item.source,
    ...(item.contentType ? { contentType: item.contentType } : {}),
    mimeType: item.mimeType,
    ...(item.rawMimeType ? { rawMimeType: item.rawMimeType } : {}),
    path: item.path!,
    fileName: item.fileName!,
    ...(item.uri ? { uri: item.uri } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

function toResultPayloadItem(item: PayloadItem): PayloadItem {
  return {
    index: item.index,
    source: item.source,
    ...(item.contentType ? { contentType: item.contentType } : {}),
    mimeType: item.mimeType,
    ...(item.rawMimeType ? { rawMimeType: item.rawMimeType } : {}),
    ...(item.uri ? { uri: item.uri } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.text !== undefined ? { text: item.text } : {}),
    ...(item.binaryBase64 !== undefined ? { binaryBase64: item.binaryBase64 } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.fileName ? { fileName: item.fileName } : {}),
    ...(item.preview ? { preview: item.preview } : {}),
  };
}

export function materializeToolCallResult(input: MaterializeCallToolResultInput): MaterializedToolCallResult {
  const settings: MaterializationSettings = {
    ...DEFAULT_MATERIALIZATION_SETTINGS,
    ...(input.settings ?? {}),
  };
  const cwd = resolve(input.cwd ?? process.cwd());
  const artifactRoot = resolveArtifactRoot(cwd, settings.artifactRoot);
  const callDir = normalizePathSlashes(join(artifactRoot, createCallDirectoryName(input.server)));
  mkdirSync(callDir, { recursive: true });

  const payloadItems: PayloadItem[] = [];
  const extracted = extractPayloadItems(input.result, settings);

  for (const [index, originalItem] of extracted.items.entries()) {
    const fileName = buildMainFileName(index + 1, originalItem);
    const filePath = normalizePathSlashes(join(callDir, fileName));
    const storedText = writePayloadMainFile(filePath, originalItem);
    const finalizedItem: PayloadItem = toResultPayloadItem({
      ...originalItem,
      index: index + 1,
      path: filePath,
      fileName,
      preview: buildItemPreview(originalItem, filePath, storedText, settings),
    });
    payloadItems.push(finalizedItem);
  }

  const payloadItemIndexes = payloadItems.map(toPayloadItemIndex);

  const manifestPath = normalizePathSlashes(join(callDir, "manifest.json"));
  const summaryText = applyHardMax(buildSummary(payloadItems, manifestPath, {
    summaryItemCount: settings.summaryItemCount,
    previewLinesPerItem: settings.previewLinesPerItem,
    previewCharsPerItem: settings.previewCharsPerItem,
    hardMaxChars: settings.hardMaxChars,
  }), settings.hardMaxChars, manifestPath);

  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      server: input.server,
      tool: input.tool,
      cwd: normalizePathSlashes(cwd),
      createdAt: new Date().toISOString(),
      callDir,
      manifestPath,
      payloadItemIndexes,
      ...(extracted.suppressedStructuredContent
        ? { suppressedStructuredContent: extracted.suppressedStructuredContent }
        : {}),
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    summaryText,
    callDir,
    manifestPath,
    payloadItems,
    payloadItemIndexes,
    mainFiles: payloadItems.map((item) => item.path!).filter(Boolean),
    metaFiles: [manifestPath],
    budget: {
      summaryItemCount: settings.summaryItemCount,
      previewLinesPerItem: settings.previewLinesPerItem,
      previewCharsPerItem: settings.previewCharsPerItem,
      hardMaxChars: settings.hardMaxChars,
    },
  };
}
