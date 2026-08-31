import { extension as getMimeExtension } from "mime-types";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { PayloadDraft, StoredPayloadItem } from "./types.js";

export interface ArtifactContext {
  readonly artifactRoot: string;
  readonly callDir: string;
  readonly manifestPath: string;
  readonly stagingDir: string;
  readonly stagingManifestPath: string;
}

export class ArtifactTransactionCleanupError extends Error {
  constructor(
    readonly materializationError: unknown,
    readonly cleanupError: unknown,
    readonly stagingDir: string,
  ) {
    super(
      `${formatError(materializationError)}; additionally failed to clean staging directory "${stagingDir}": ${formatError(cleanupError)}`,
      { cause: materializationError },
    );
    this.name = "ArtifactTransactionCleanupError";
  }
}

const pendingArtifactContexts = new WeakSet<ArtifactContext>();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizePayloadFileNameSegment(value: string): string {
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
  const suffix = randomBytes(2).toString("hex");
  return `${server}-${toCompactUtcTimestamp()}-${suffix}`;
}

export function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

const PREFERRED_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpg": "jpg",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

function inferExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = PREFERRED_MIME_EXTENSIONS[normalized] ?? getMimeExtension(normalized);
  return extension ? `.${extension}` : ".bin";
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
      stem = shortenNormalizedBase(sanitizePayloadFileNameSegment(baseName.replace(extname(baseName), "")));
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
  server: string;
  artifactDir: string;
}): ArtifactContext {
  const artifactRoot = resolve(input.artifactDir);
  const callDirName = createCallDirectoryName(input.server);
  const callDir = normalizePathSlashes(join(artifactRoot, callDirName));
  const stagingDir = normalizePathSlashes(join(artifactRoot, `.partial-${callDirName}`));
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(stagingDir);

  const context: ArtifactContext = {
    artifactRoot: normalizePathSlashes(artifactRoot),
    callDir,
    manifestPath: normalizePathSlashes(join(callDir, "manifest.json")),
    stagingDir,
    stagingManifestPath: normalizePathSlashes(join(stagingDir, "manifest.json")),
  };
  pendingArtifactContexts.add(context);
  return context;
}

function assertOwnedStagingDirectory(context: ArtifactContext): void {
  if (!pendingArtifactContexts.has(context)) {
    throw new Error("Artifact staging directory is not owned by an active materialization transaction.");
  }

  const artifactRoot = resolve(context.artifactRoot);
  const stagingDir = resolve(context.stagingDir);
  if (dirname(stagingDir) !== artifactRoot || !basename(stagingDir).startsWith(".partial-")) {
    throw new Error(`Refusing to operate on unsafe artifact staging directory: ${context.stagingDir}`);
  }
}

export function commitArtifactContext(context: ArtifactContext): void {
  assertOwnedStagingDirectory(context);
  if (existsSync(context.callDir)) {
    throw new Error(`Artifact call directory already exists: ${context.callDir}`);
  }
  renameSync(context.stagingDir, context.callDir);
  pendingArtifactContexts.delete(context);
}

export function rollbackArtifactContext(context: ArtifactContext): void {
  assertOwnedStagingDirectory(context);
  const stats = lstatSync(context.stagingDir, { throwIfNoEntry: false });
  if (stats) {
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Refusing to remove unsafe artifact staging path: ${context.stagingDir}`);
    }
    rmSync(context.stagingDir, { recursive: true });
  }
  pendingArtifactContexts.delete(context);
}

export function storePayloadItems(items: PayloadDraft[], context: Pick<ArtifactContext, "callDir" | "stagingDir">): StoredPayloadItem[] {
  return items.map((item, index) => {
    const fileName = buildMainFileName(index + 1, item);
    const filePath = normalizePathSlashes(join(context.callDir, fileName));
    const stagingFilePath = normalizePathSlashes(join(context.stagingDir, fileName));
    writePayloadMainFile(stagingFilePath, item);
    return toStoredPayloadItem({
      ...item,
      index: index + 1,
      path: filePath,
      fileName,
    });
  });
}
