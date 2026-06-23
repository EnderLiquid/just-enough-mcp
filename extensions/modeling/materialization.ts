export type MaterializedPayloadKind =
  | "text"
  | "image"
  | "audio"
  | "resource.text"
  | "resource.blob"
  | "structuredContent"
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
  index: number;
  kind: MaterializedPayloadKind;
  source: string;
  path: string;
  fileName: string;
  mimeType?: string;
  uri?: string;
  preview: string[];
}

export interface MaterializedToolCallResult {
  summaryText: string;
  callDir: string;
  manifestPath: string;
  payloadItems: PayloadItem[];
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
