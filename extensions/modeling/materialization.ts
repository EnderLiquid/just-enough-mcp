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
  summaryMaxLines: number;
  summaryMaxChars: number;
  previewLinesPerItem: number;
  previewCharsPerItem: number;
  previewItemCount: number;
  prettyPrintJson: boolean;
}

export interface SummaryBudget {
  summaryMaxLines: number;
  summaryMaxChars: number;
  previewLinesPerItem: number;
  previewCharsPerItem: number;
  previewItemCount: number;
}

export interface PayloadItem {
  index: number;
  kind: MaterializedPayloadKind;
  source: string;
  path: string;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  uri?: string;
  preview?: string[];
}

export interface MaterializedToolCallResult {
  summaryText: string;
  callDir: string;
  summaryPath: string;
  manifestPath: string;
  payloadItems: PayloadItem[];
  mainFiles: string[];
  metaFiles: string[];
  budget: SummaryBudget;
  summaryTruncated: boolean;
}

export const DEFAULT_MATERIALIZATION_SETTINGS: MaterializationSettings = {
  artifactRoot: ".pi/mcp-artifacts",
  summaryMaxLines: 80,
  summaryMaxChars: 12000,
  previewLinesPerItem: 4,
  previewCharsPerItem: 800,
  previewItemCount: 6,
  prettyPrintJson: true,
};
