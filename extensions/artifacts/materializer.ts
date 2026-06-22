import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MATERIALIZATION_SETTINGS,
  type MaterializedPayloadKind,
  type MaterializedToolCallResult,
  type MaterializationSettings,
  type PayloadItem,
  type SummaryBudget,
} from "../modeling/materialization.js";

interface InternalPayloadItem {
  kind: MaterializedPayloadKind;
  source: string;
  mimeType?: string;
  uri?: string;
  text?: string;
  binaryBase64?: string;
  structuredData?: Record<string, unknown>;
}

interface TextPreviewResult {
  lines: string[];
  truncated: boolean;
}

function isEmbeddedTextResource(resource: unknown): resource is { uri: string; text: string; mimeType?: string } {
  return typeof resource === "object" && resource !== null && "text" in resource && typeof (resource as { text?: unknown }).text === "string";
}

function isEmbeddedBlobResource(resource: unknown): resource is { uri: string; blob: string; mimeType?: string } {
  return typeof resource === "object" && resource !== null && "blob" in resource && typeof (resource as { blob?: unknown }).blob === "string";
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

function toUtcTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function createCallDirectoryName(server: string, tool: string): string {
  const target = sanitizeSegment(`${server}-${tool}`).slice(0, 64);
  const suffix = randomBytes(2).toString("hex");
  return `${target}-${toUtcTimestamp()}-${suffix}`;
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveArtifactRoot(cwd: string, artifactRoot: string): string {
  return isAbsolute(artifactRoot) ? artifactRoot : resolve(cwd, artifactRoot);
}

function inferExtensionFromMimeType(mimeType?: string): string | undefined {
  if (!mimeType) return undefined;

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
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "text/csv": ".csv",
  };

  if (mapping[normalized]) {
    return mapping[normalized];
  }

  const subtype = normalized.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) return undefined;
  if (subtype === "jpeg") return ".jpg";
  return `.${subtype.replace(/[^A-Za-z0-9]+/g, "")}`;
}

function inferExtensionFromUri(uri?: string): string | undefined {
  if (!uri) return undefined;

  try {
    const parsed = new URL(uri);
    const ext = extname(parsed.pathname);
    return ext || undefined;
  } catch {
    const ext = extname(uri);
    return ext || undefined;
  }
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

function normalizeJsonText(value: string): string {
  try {
    return `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
  } catch {
    return value.endsWith("\n") ? value : `${value}\n`;
  }
}

function toStoredText(kind: MaterializedPayloadKind, value: string, prettyPrintJson: boolean): string {
  if (kind === "structuredContent") {
    return normalizeJsonText(value);
  }

  if (prettyPrintJson) {
    return normalizeJsonText(value);
  }

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

function isTextualKind(kind: MaterializedPayloadKind): boolean {
  return kind === "text" || kind === "resource.text" || kind === "structuredContent" || kind === "unknown";
}

function extractPayloadItems(result: CallToolResult): InternalPayloadItem[] {
  const items: InternalPayloadItem[] = [];

  for (const [index, content] of (result.content ?? []).entries()) {
    const source = `content[${index}]`;

    if (content.type === "text") {
      items.push({ kind: "text", source, text: content.text ?? "" });
      continue;
    }

    if (content.type === "image") {
      items.push({ kind: "image", source, mimeType: content.mimeType, binaryBase64: content.data ?? "" });
      continue;
    }

    if (content.type === "audio") {
      items.push({ kind: "audio", source, mimeType: content.mimeType, binaryBase64: content.data ?? "" });
      continue;
    }

    if (content.type === "resource") {
      if (isEmbeddedTextResource(content.resource)) {
        items.push({
          kind: "resource.text",
          source,
          mimeType: content.resource.mimeType,
          uri: content.resource.uri,
          text: content.resource.text,
        });
        continue;
      }

      if (isEmbeddedBlobResource(content.resource)) {
        items.push({
          kind: "resource.blob",
          source,
          mimeType: content.resource.mimeType,
          uri: content.resource.uri,
          binaryBase64: content.resource.blob,
        });
        continue;
      }
    }

    items.push({ kind: "unknown", source, text: JSON.stringify(content, null, 2) });
  }

  if (result.structuredContent && typeof result.structuredContent === "object") {
    items.push({
      kind: "structuredContent",
      source: "structuredContent",
      structuredData: result.structuredContent,
      text: JSON.stringify(result.structuredContent, null, 2),
      mimeType: "application/json",
    });
  }

  return items;
}

function buildMainFileName(index: number, item: InternalPayloadItem): string {
  const prefix = String(index).padStart(2, "0");
  const baseName = inferBaseNameFromUri(item.uri);
  const normalizedBase = baseName ? sanitizeSegment(baseName.replace(extname(baseName), "")) : undefined;
  const extFromUri = inferExtensionFromUri(item.uri);
  const extFromMime = inferExtensionFromMimeType(item.mimeType);

  switch (item.kind) {
    case "text":
      return `${prefix}-text.txt`;
    case "image":
      return `${prefix}-image${extFromMime ?? ".bin"}`;
    case "audio":
      return `${prefix}-audio${extFromMime ?? ".bin"}`;
    case "resource.text":
      return `${prefix}-${normalizedBase ?? "resource"}${extFromUri ?? extFromMime ?? ".txt"}`;
    case "resource.blob":
      return `${prefix}-${normalizedBase ?? "resource"}${extFromUri ?? extFromMime ?? ".bin"}`;
    case "structuredContent":
      return `${prefix}-structured.json`;
    case "unknown":
    default:
      return `${prefix}-unknown.txt`;
  }
}

function writePayloadMainFile(filePath: string, item: InternalPayloadItem, settings: MaterializationSettings): string | undefined {
  if (item.kind === "image" || item.kind === "audio" || item.kind === "resource.blob") {
    const binary = Buffer.from(item.binaryBase64 ?? "", "base64");
    writeFileSync(filePath, binary);
    return undefined;
  }

  const text = item.kind === "structuredContent"
    ? `${JSON.stringify(item.structuredData ?? {}, null, 2)}\n`
    : toStoredText(item.kind, item.text ?? "", settings.prettyPrintJson);
  writeFileSync(filePath, text, "utf8");
  return text;
}

function buildItemPreview(item: InternalPayloadItem, absolutePath: string, storedText: string | undefined, settings: MaterializationSettings): string[] {
  if (!isTextualKind(item.kind) || storedText === undefined) {
    return [`File: ${absolutePath}`];
  }

  const preview = buildTextPreview(storedText, settings.previewLinesPerItem, settings.previewCharsPerItem);
  if (!preview.truncated) {
    return preview.lines;
  }

  return [...preview.lines, `Full output: ${absolutePath}`];
}

function joinSections(sections: string[][]): string {
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

function buildSummary(payloadItems: PayloadItem[], manifestPath: string, budget: SummaryBudget): string {
  if (payloadItems.length === 0) {
    return "(empty result)\n";
  }

  if (payloadItems.length === 1) {
    return `${payloadItems[0].preview.join("\n")}\n`;
  }

  const sections: string[][] = [];
  const displayedItems = payloadItems.slice(0, budget.summaryItemCount);

  for (const item of displayedItems) {
    sections.push([`[${item.index}] ${item.kind}`, ...item.preview]);
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

export function materializeToolCallResult(input: MaterializeCallToolResultInput): MaterializedToolCallResult {
  const settings: MaterializationSettings = {
    ...DEFAULT_MATERIALIZATION_SETTINGS,
    ...(input.settings ?? {}),
  };
  const cwd = resolve(input.cwd ?? process.cwd());
  const artifactRoot = resolveArtifactRoot(cwd, settings.artifactRoot);
  const callDir = normalizePathSlashes(join(artifactRoot, createCallDirectoryName(input.server, input.tool)));
  mkdirSync(callDir, { recursive: true });

  const payloadItems: PayloadItem[] = [];
  const internalItems = extractPayloadItems(input.result);

  for (const [index, item] of internalItems.entries()) {
    const fileName = buildMainFileName(index + 1, item);
    const filePath = normalizePathSlashes(join(callDir, fileName));
    const storedText = writePayloadMainFile(filePath, item, settings);
    payloadItems.push({
      index: index + 1,
      kind: item.kind,
      source: item.source,
      path: filePath,
      fileName,
      mimeType: item.mimeType,
      uri: item.uri,
      preview: buildItemPreview(item, filePath, storedText, settings),
    });
  }

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
      payloadItems: payloadItems.map((item) => ({
        index: item.index,
        kind: item.kind,
        source: item.source,
        path: item.path,
        fileName: item.fileName,
        mimeType: item.mimeType,
        uri: item.uri,
      })),
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    summaryText,
    callDir,
    manifestPath,
    payloadItems,
    mainFiles: payloadItems.map((item) => item.path),
    metaFiles: [manifestPath],
    budget: {
      summaryItemCount: settings.summaryItemCount,
      previewLinesPerItem: settings.previewLinesPerItem,
      previewCharsPerItem: settings.previewCharsPerItem,
      hardMaxChars: settings.hardMaxChars,
    },
  };
}
