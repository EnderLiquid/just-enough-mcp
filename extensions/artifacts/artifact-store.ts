import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { MaterializationSettings, PayloadDraft, StoredPayloadItem } from "./types.js";

export interface ArtifactContext {
  cwd: string;
  artifactRoot: string;
  callDir: string;
  manifestPath: string;
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

export function normalizePathSlashes(value: string): string {
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

function buildDefaultStem(item: PayloadDraft): string {
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

function buildMainFileName(index: number, item: PayloadDraft): string {
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

function writePayloadMainFile(filePath: string, item: PayloadDraft): void {
  if (item.binaryBase64 !== undefined) {
    const binary = Buffer.from(item.binaryBase64, "base64");
    writeFileSync(filePath, binary);
    return;
  }

  const text = item.text ?? "";
  writeFileSync(filePath, text, "utf8");
}

function toStoredPayloadItem(item: PayloadDraft & { index: number; path: string; fileName: string }): StoredPayloadItem {
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
    path: item.path,
    fileName: item.fileName,
  };
}

export function createArtifactContext(input: {
  cwd: string;
  server: string;
  settings: Pick<MaterializationSettings, "artifactRoot">;
}): ArtifactContext {
  const cwd = resolve(input.cwd);
  const artifactRoot = resolveArtifactRoot(cwd, input.settings.artifactRoot);
  const callDir = normalizePathSlashes(join(artifactRoot, createCallDirectoryName(input.server)));
  mkdirSync(callDir, { recursive: true });

  return {
    cwd: normalizePathSlashes(cwd),
    artifactRoot: normalizePathSlashes(artifactRoot),
    callDir,
    manifestPath: normalizePathSlashes(join(callDir, "manifest.json")),
  };
}

export function storePayloadItems(items: PayloadDraft[], context: Pick<ArtifactContext, "callDir">): StoredPayloadItem[] {
  return items.map((item, index) => {
    const fileName = buildMainFileName(index + 1, item);
    const filePath = normalizePathSlashes(join(context.callDir, fileName));
    writePayloadMainFile(filePath, item);
    return toStoredPayloadItem({
      ...item,
      index: index + 1,
      path: filePath,
      fileName,
    });
  });
}
