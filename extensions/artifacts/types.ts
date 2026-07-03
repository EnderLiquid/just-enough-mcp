export type PayloadContentType =
  | "text"
  | "image"
  | "audio"
  | "resource"
  | "resource_link"
  | "unknown";

export interface ArtifactStorageSettings {
  artifactRoot: string;
}

export interface PayloadNormalizationSettings {
  prettyPrintJson: boolean;
}

export interface SummarySettings {
  summaryItemCount: number;
  previewFullCharsPerItem: number;
  previewTruncateToCharsPerItem: number;
  hardMaxChars: number;
}

export interface TuiResultRenderSettings {
  collapsedPreviewLines: number;
}

export interface MaterializationSettings extends ArtifactStorageSettings, PayloadNormalizationSettings, SummarySettings {}

export interface ResultPresentationSettings extends MaterializationSettings, TuiResultRenderSettings {}

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

export interface PayloadDraft {
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  uri?: string;
  description?: string;
  text?: string;
  binaryBase64?: string;
  parsedJson?: unknown;
}

export interface ExtractedPayloadDrafts {
  contentItems: PayloadDraft[];
  structuredContent?: Record<string, unknown>;
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

export const DEFAULT_RESULT_PRESENTATION_SETTINGS: ResultPresentationSettings = {
  artifactRoot: ".pi/mcp",
  summaryItemCount: 6,
  previewFullCharsPerItem: 1500,
  previewTruncateToCharsPerItem: 600,
  hardMaxChars: 40000,
  prettyPrintJson: true,
  collapsedPreviewLines: 4,
};

export const DEFAULT_MATERIALIZATION_SETTINGS: MaterializationSettings = {
  artifactRoot: DEFAULT_RESULT_PRESENTATION_SETTINGS.artifactRoot,
  summaryItemCount: DEFAULT_RESULT_PRESENTATION_SETTINGS.summaryItemCount,
  previewFullCharsPerItem: DEFAULT_RESULT_PRESENTATION_SETTINGS.previewFullCharsPerItem,
  previewTruncateToCharsPerItem: DEFAULT_RESULT_PRESENTATION_SETTINGS.previewTruncateToCharsPerItem,
  hardMaxChars: DEFAULT_RESULT_PRESENTATION_SETTINGS.hardMaxChars,
  prettyPrintJson: DEFAULT_RESULT_PRESENTATION_SETTINGS.prettyPrintJson,
};
