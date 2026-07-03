import { isDeepStrictEqual } from "node:util";
import type {
  ExtractedPayloadDrafts,
  MaterializationSettings,
  PayloadDraft,
  SuppressedStructuredContent,
} from "./types.js";

export interface NormalizedPayloadDrafts {
  items: PayloadDraft[];
  suppressedStructuredContent?: SuppressedStructuredContent;
}

function normalizeJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}`;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isTextualPayload(item: PayloadDraft): boolean {
  return typeof item.text === "string";
}

function isJsonTextualPayload(item: PayloadDraft): boolean {
  return isTextualPayload(item) && item.mimeType === "application/json" && item.parsedJson !== undefined;
}

function withRawMimeType(item: PayloadDraft, rawMimeType: string | undefined): PayloadDraft {
  if (!rawMimeType || rawMimeType === item.mimeType) {
    return item;
  }

  return {
    ...item,
    rawMimeType,
  };
}

function normalizeTextPayload(item: PayloadDraft, prettyPrintJson: boolean): PayloadDraft {
  if (item.text == undefined) return item;
  const normalized = item.text.replace(/\r\n/g, "\n");
  const parsedJson = tryParseJson(normalized);
  if (parsedJson === undefined) {
    return {
      ...item,
      mimeType: item.mimeType || "text/plain",
      text: normalized,
    };
  }

  const text = prettyPrintJson
    ? normalizeJsonText(parsedJson) : normalized;

  return withRawMimeType({
    ...item,
    mimeType: "application/json",
    text,
    parsedJson,
  }, item.mimeType);
}

function normalizeStructuredContent(value: Record<string, unknown>): PayloadDraft {
  return {
    source: "structuredContent",
    mimeType: "application/json",
    text: normalizeJsonText(value),
    parsedJson: value,
  };
}

function findSuppressedStructuredContent(
  structuredItem: PayloadDraft,
  items: PayloadDraft[],
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

export function normalizePayloadDrafts(
  extracted: ExtractedPayloadDrafts,
  settings: Pick<MaterializationSettings, "prettyPrintJson">,
): NormalizedPayloadDrafts {
  const items = extracted.contentItems.map(item => normalizeTextPayload(item, settings.prettyPrintJson));
  let suppressedStructuredContent: SuppressedStructuredContent | undefined;

  if (extracted.structuredContent) {
    const structuredItem = normalizeStructuredContent(extracted.structuredContent);
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
