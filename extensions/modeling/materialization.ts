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

export const DEFAULT_MATERIALIZATION_SETTINGS: MaterializationSettings = {
  artifactRoot: ".pi/mcp-artifacts",
  summaryItemCount: 6,
  previewLinesPerItem: 4,
  previewCharsPerItem: 800,
  hardMaxChars: 40000,
  prettyPrintJson: true,
};
