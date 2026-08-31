import { writeFileSync } from "node:fs";
import type { ArtifactContext } from "./artifact-store.js";
import type { ManifestPayloadItem, StoredPayloadItem, SuppressedStructuredContent } from "./types.js";

export interface WriteToolCallManifestInput {
  server: string;
  tool: string;
  context: ArtifactContext;
  payloadItems: StoredPayloadItem[];
  suppressedStructuredContent?: SuppressedStructuredContent;
}

export interface WrittenToolCallManifest {
  manifestPath: string;
  payloadItems: ManifestPayloadItem[];
}

export function toManifestPayloadItem(item: StoredPayloadItem): ManifestPayloadItem {
  return {
    index: item.index,
    source: item.source,
    ...(item.contentType ? { contentType: item.contentType } : {}),
    mimeType: item.mimeType,
    ...(item.rawMimeType ? { rawMimeType: item.rawMimeType } : {}),
    path: item.path,
    fileName: item.fileName,
    ...(item.uri ? { uri: item.uri } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

export function writeToolCallManifest(input: WriteToolCallManifestInput): WrittenToolCallManifest {
  const payloadItems = input.payloadItems.map(toManifestPayloadItem);

  writeFileSync(
    input.context.stagingManifestPath,
    `${JSON.stringify({
      server: input.server,
      tool: input.tool,
      createdAt: new Date().toISOString(),
      callDir: input.context.callDir,
      manifestPath: input.context.manifestPath,
      payloadItems,
      ...(input.suppressedStructuredContent
        ? { suppressedStructuredContent: input.suppressedStructuredContent }
        : {}),
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    manifestPath: input.context.manifestPath,
    payloadItems,
  };
}
