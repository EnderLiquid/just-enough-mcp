export type PayloadContentType =
  | "text"
  | "image"
  | "audio"
  | "resource"
  | "resource_link"
  | "unknown";

export interface MaterializationSettings {
  artifactRoot: string;
  summaryItemCount: number;
  previewLinesPerItem: number;
  previewCharsPerItem: number;
  hardMaxChars: number;
  prettyPrintJson: boolean;
}

export interface ResultPresentationSettings extends MaterializationSettings {
  collapsedPreviewLines: number;
}

export interface SummaryBudget {
  summaryItemCount: number;
  previewLinesPerItem: number;
  previewCharsPerItem: number;
  hardMaxChars: number;
}

export interface PayloadItem {
  index?: number;
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  uri?: string;
  description?: string;
  text?: string;
  binaryBase64?: string;
  parsedJson?: unknown;
  path?: string;
  fileName?: string;
  preview?: string[];
}

export interface PayloadItemIndex {
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
  payloadItems: PayloadItem[];
  payloadItemIndexes: PayloadItemIndex[];
  mainFiles: string[];
  metaFiles: string[];
  budget: SummaryBudget;
}

export const DEFAULT_RESULT_PRESENTATION_SETTINGS: ResultPresentationSettings = {
  artifactRoot: ".pi/mcp",
  summaryItemCount: 6,
  previewLinesPerItem: 12,
  previewCharsPerItem: 800,
  hardMaxChars: 40000,
  prettyPrintJson: true,
  collapsedPreviewLines: 4,
};

export const DEFAULT_MATERIALIZATION_SETTINGS: MaterializationSettings = {
  artifactRoot: DEFAULT_RESULT_PRESENTATION_SETTINGS.artifactRoot,
  summaryItemCount: DEFAULT_RESULT_PRESENTATION_SETTINGS.summaryItemCount,
  previewLinesPerItem: DEFAULT_RESULT_PRESENTATION_SETTINGS.previewLinesPerItem,
  previewCharsPerItem: DEFAULT_RESULT_PRESENTATION_SETTINGS.previewCharsPerItem,
  hardMaxChars: DEFAULT_RESULT_PRESENTATION_SETTINGS.hardMaxChars,
  prettyPrintJson: DEFAULT_RESULT_PRESENTATION_SETTINGS.prettyPrintJson,
};
