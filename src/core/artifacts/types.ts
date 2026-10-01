export type PayloadContentType =
  | "text"
  | "image"
  | "audio"
  | "resource"
  | "resource_link"
  | "unknown";

export interface PayloadNormalizationSettings {
  prettyPrintJson: boolean;
}

export interface SummarySettings {
  summaryItemCount: number;
  previewFullCharsPerItem: number;
  previewTruncateToCharsPerItem: number;
  hardMaxChars: number;
}

export interface MaterializationSettings extends PayloadNormalizationSettings, SummarySettings {}

export interface SummaryBudget {
  summaryItemCount: number;
  previewFullCharsPerItem: number;
  previewTruncateToCharsPerItem: number;
  hardMaxChars: number;
}

export interface SuppressedStructuredContent {
  duplicateOf: number;
  reason: "semantic-json-equal" | "exact-text-equal";
}

export interface ExtractedPayloadItem {
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  uri?: string;
  description?: string;
  text?: string;
  binaryBase64?: string;
}

export interface ExtractedPayloads {
  contentItems: ExtractedPayloadItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface NormalizedPayloadItem extends ExtractedPayloadItem {
  parsedJson?: unknown;
}

export interface PreparedToolCallResult {
  items: NormalizedPayloadItem[];
  structuredContent?: Record<string, unknown>;
  suppressedStructuredContent?: SuppressedStructuredContent;
  isError?: boolean;
}

export interface StoredPayloadItem {
  index: number;
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  uri?: string;
  description?: string;
  text?: string;
  binaryBase64?: string;
  parsedJson?: unknown;
  path: string;
  fileName: string;
  preview?: string[];
}

export interface ManifestPayloadItem {
  index: number;
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  path: string;
  fileName: string;
  uri?: string;
  description?: string;
}

export interface MaterializedToolCallResult {
  summaryText: string;
  callDir: string;
  manifestPath: string;
  payloadItems: StoredPayloadItem[];
  manifestPayloadItems: ManifestPayloadItem[];
  mainFiles: string[];
  metaFiles: string[];
  budget: SummaryBudget;
}

export const DEFAULT_MATERIALIZATION_SETTINGS: MaterializationSettings = {
  summaryItemCount: 6,
  previewFullCharsPerItem: 1500,
  previewTruncateToCharsPerItem: 600,
  hardMaxChars: 40000,
  prettyPrintJson: true,
};
