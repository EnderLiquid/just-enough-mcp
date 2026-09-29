import { isDeepStrictEqual } from "node:util";
import type {
  ExtractedPayloadItem,
  ExtractedPayloads,
  MaterializationSettings,
  NormalizedPayloadItem,
  PreparedToolCallResult,
  SuppressedStructuredContent,
} from "./types.js";

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

function isTextualPayload(item: ExtractedPayloadItem | NormalizedPayloadItem): boolean {
  return typeof item.text === "string";
}

function isJsonTextualPayload(item: NormalizedPayloadItem): boolean {
  return isTextualPayload(item) && item.mimeType === "application/json" && item.parsedJson !== undefined;
}

function withRawMimeType<T extends ExtractedPayloadItem | NormalizedPayloadItem>(
  item: T,
  rawMimeType: string | undefined,
): T {
  if (!rawMimeType || rawMimeType === item.mimeType) {
    return item;
  }

  return {
    ...item,
    rawMimeType,
  } as T;
}

function normalizeTextPayload(
  item: ExtractedPayloadItem,
  prettyPrintJson: boolean,
): NormalizedPayloadItem {
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

function normalizeStructuredContent(value: Record<string, unknown>): NormalizedPayloadItem {
  return {
    source: "structuredContent",
    mimeType: "application/json",
    text: normalizeJsonText(value),
    parsedJson: value,
  };
}

function findSuppressedStructuredContent(
  structuredItem: NormalizedPayloadItem,
  items: NormalizedPayloadItem[],
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

export function normalizePayloadItems(
  extracted: ExtractedPayloads,
  settings: Pick<MaterializationSettings, "prettyPrintJson">,
): PreparedToolCallResult {
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
    ...(extracted.structuredContent ? { structuredContent: extracted.structuredContent } : {}),
    ...(extracted.isError !== undefined ? { isError: extracted.isError } : {}),
    ...(suppressedStructuredContent ? { suppressedStructuredContent } : {}),
  };
}
