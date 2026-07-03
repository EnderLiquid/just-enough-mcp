import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExtractedPayloadDrafts, PayloadDraft } from "./types.js";

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

export function extractPayloadDrafts(result: CallToolResult): ExtractedPayloadDrafts {
  const contentItems: PayloadDraft[] = [];

  for (const [index, content] of (result.content ?? []).entries()) {
    const source = `content[${index}]`;

    if (content.type === "text") {
      contentItems.push({
        source,
        contentType: "text",
        mimeType: "text/plain",
        text: content.text ?? "",
      });
      continue;
    }

    if (content.type === "image") {
      contentItems.push({
        source,
        contentType: "image",
        mimeType: content.mimeType ?? "application/octet-stream",
        binaryBase64: content.data ?? "",
      });
      continue;
    }

    if (content.type === "audio") {
      contentItems.push({
        source,
        contentType: "audio",
        mimeType: content.mimeType ?? "application/octet-stream",
        binaryBase64: content.data ?? "",
      });
      continue;
    }

    if (isResourceLink(content)) {
      const rawMimeType = content.mimeType;
      contentItems.push({
        source,
        contentType: "resource_link",
        mimeType: "text/plain",
        rawMimeType,
        uri: content.uri,
        description: content.description,
        text: buildResourceLinkText(content.uri, content.description, rawMimeType),
      });
      continue;
    }

    if (content.type === "resource") {
      if (isEmbeddedTextResource(content.resource)) {
        contentItems.push({
          source,
          contentType: "resource",
          mimeType: content.resource.mimeType ?? "text/plain",
          uri: content.resource.uri,
          text: content.resource.text,
        });
        continue;
      }

      if (isEmbeddedBlobResource(content.resource)) {
        contentItems.push({
          source,
          contentType: "resource",
          mimeType: content.resource.mimeType ?? "application/octet-stream",
          uri: content.resource.uri,
          binaryBase64: content.resource.blob,
        });
        continue;
      }
    }

    contentItems.push({
      source,
      contentType: "unknown",
      mimeType: "text/plain",
      text: JSON.stringify(content, null, 2),
    });
  }

  return {
    contentItems,
    ...(result.structuredContent && typeof result.structuredContent === "object"
      ? { structuredContent: result.structuredContent as Record<string, unknown> }
      : {}),
  };
}
