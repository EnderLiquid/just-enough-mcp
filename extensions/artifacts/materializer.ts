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

function toDisplayPath(cwd: string, targetPath: string): string {
  const normalizedCwd = normalizePathSlashes(resolve(cwd));
  const normalizedTarget = normalizePathSlashes(resolve(targetPath));
  if (normalizedTarget.startsWith(`${normalizedCwd}/`)) {
    return normalizedTarget.slice(normalizedCwd.length + 1);
  }
  return normalizedTarget;
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

function buildTextPreview(text: string, maxLines: number, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) return ["(empty text)"];

  const clipped = normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 1))}…` : normalized;
  const lines = clipped.split("\n");
  if (lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines), "…"];
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

function buildSummary(
  server: string,
  tool: string,
  payloadItems: PayloadItem[],
  budget: SummaryBudget,
): { text: string; truncated: boolean } {
  const lines: string[] = [
    "MCP result materialized",
    `- server: ${server}`,
    `- tool: ${tool}`,
    `- payload items: ${payloadItems.length}`,
    `- main files: ${payloadItems.length}`,
    "- meta files: 2",
    "",
  ];

  let truncated = false;
  let previewedItems = 0;
  let lineCount = lines.length;
  let charCount = lines.join("\n").length;

  const canAppend = (candidateLines: string[]): boolean => {
    const nextLineCount = lineCount + candidateLines.length;
    const nextCharCount = charCount + 1 + candidateLines.join("\n").length;
    return nextLineCount <= budget.summaryMaxLines && nextCharCount <= budget.summaryMaxChars;
  };

  const appendLines = (candidateLines: string[]): boolean => {
    if (!canAppend(candidateLines)) return false;
    lines.push(...candidateLines);
    lineCount += candidateLines.length;
    charCount += 1 + candidateLines.join("\n").length;
    return true;
  };

  for (const [index, item] of payloadItems.entries()) {
    const baseLines = [
      `[${index + 1}] ${item.kind}`,
      `- source: ${item.source}`,
      `- path: ${item.relativePath}`,
    ];

    if (item.mimeType) {
      baseLines.push(`- mimeType: ${item.mimeType}`);
    }

    if (item.uri) {
      baseLines.push(`- uri: ${item.uri}`);
    }

    if (!appendLines(baseLines)) {
      truncated = true;
      break;
    }

    const canPreview = isTextualKind(item.kind) && Array.isArray(item.preview) && item.preview.length > 0 && previewedItems < budget.previewItemCount;
    if (!canPreview) {
      continue;
    }

    const previewLines = ["- preview:", ...(item.preview ?? []).map((line) => `  ${line}`)];
    if (!appendLines(previewLines)) {
      truncated = true;
      continue;
    }

    previewedItems += 1;
  }

  if (truncated) {
    const tail = "… remaining items omitted from preview; inspect main files or manifest.json";
    if (canAppend([tail])) {
      lines.push(tail);
    } else if (lines.length > 0) {
      lines[lines.length - 1] = tail;
    }
  }

  return {
    text: `${lines.join("\n")}\n`,
    truncated,
  };
}

export function materializeToolCallResult(input: MaterializeCallToolResultInput): MaterializedToolCallResult {
  const settings: MaterializationSettings = {
    ...DEFAULT_MATERIALIZATION_SETTINGS,
    ...(input.settings ?? {}),
  };
  const cwd = resolve(input.cwd ?? process.cwd());
  const artifactRoot = resolveArtifactRoot(cwd, settings.artifactRoot);
  const callDir = join(artifactRoot, createCallDirectoryName(input.server, input.tool));
  mkdirSync(callDir, { recursive: true });

  const payloadItems: PayloadItem[] = [];
  const internalItems = extractPayloadItems(input.result);

  for (const [index, item] of internalItems.entries()) {
    const fileName = buildMainFileName(index + 1, item);
    const filePath = join(callDir, fileName);
    const storedText = writePayloadMainFile(filePath, item, settings);
    payloadItems.push({
      index: index + 1,
      kind: item.kind,
      source: item.source,
      path: filePath,
      relativePath: toDisplayPath(cwd, filePath),
      fileName,
      mimeType: item.mimeType,
      uri: item.uri,
      preview: storedText && isTextualKind(item.kind)
        ? buildTextPreview(storedText, settings.previewLinesPerItem, settings.previewCharsPerItem)
        : undefined,
    });
  }

  const summary = buildSummary(input.server, input.tool, payloadItems, {
    summaryMaxLines: settings.summaryMaxLines,
    summaryMaxChars: settings.summaryMaxChars,
    previewLinesPerItem: settings.previewLinesPerItem,
    previewCharsPerItem: settings.previewCharsPerItem,
    previewItemCount: settings.previewItemCount,
  });

  const summaryPath = join(callDir, "summary.txt");
  const manifestPath = join(callDir, "manifest.json");
  writeFileSync(summaryPath, summary.text, "utf8");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      server: input.server,
      tool: input.tool,
      cwd,
      createdAt: new Date().toISOString(),
      callDir: toDisplayPath(cwd, callDir),
      summaryPath: toDisplayPath(cwd, summaryPath),
      manifestPath: toDisplayPath(cwd, manifestPath),
      payloadItems: payloadItems.map((item) => ({
        index: item.index,
        kind: item.kind,
        source: item.source,
        path: item.fileName,
        mimeType: item.mimeType,
        uri: item.uri,
      })),
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    summaryText: summary.text,
    callDir,
    summaryPath,
    manifestPath,
    payloadItems,
    mainFiles: payloadItems.map((item) => item.path),
    metaFiles: [summaryPath, manifestPath],
    budget: {
      summaryMaxLines: settings.summaryMaxLines,
      summaryMaxChars: settings.summaryMaxChars,
      previewLinesPerItem: settings.previewLinesPerItem,
      previewCharsPerItem: settings.previewCharsPerItem,
      previewItemCount: settings.previewItemCount,
    },
    summaryTruncated: summary.truncated,
  };
}
