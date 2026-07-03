import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createArtifactContext, storePayloadItems } from "./artifact-store.js";
import { writeToolCallManifest } from "./manifest.js";
import { extractPayloadDrafts } from "./payload-extractor.js";
import { normalizePayloadDrafts } from "./payload-normalizer.js";
import { attachPayloadPreviews, buildResultSummary } from "./result-summary.js";
import {
  DEFAULT_MATERIALIZATION_SETTINGS,
  type MaterializedToolCallResult,
  type MaterializationSettings,
  type SummaryBudget,
} from "./types.js";

export interface MaterializeCallToolResultInput {
  cwd?: string;
  server: string;
  tool: string;
  result: CallToolResult;
  settings?: Partial<MaterializationSettings>;
}

function toSummaryBudget(settings: MaterializationSettings): SummaryBudget {
  return {
    summaryItemCount: settings.summaryItemCount,
    previewFullCharsPerItem: settings.previewFullCharsPerItem,
    previewTruncateToCharsPerItem: settings.previewTruncateToCharsPerItem,
    hardMaxChars: settings.hardMaxChars,
  };
}

export function materializeToolCallResult(input: MaterializeCallToolResultInput): MaterializedToolCallResult {
  const settings: MaterializationSettings = {
    ...DEFAULT_MATERIALIZATION_SETTINGS,
    ...(input.settings ?? {}),
  };

  const context = createArtifactContext({
    cwd: input.cwd ?? process.cwd(),
    server: input.server,
    settings,
  });

  const extracted = extractPayloadDrafts(input.result);
  const normalized = normalizePayloadDrafts(extracted, settings);
  const storedItems = storePayloadItems(normalized.items, context);
  const payloadItems = attachPayloadPreviews(storedItems, settings);
  const manifest = writeToolCallManifest({
    server: input.server,
    tool: input.tool,
    context,
    payloadItems,
    suppressedStructuredContent: normalized.suppressedStructuredContent,
  });
  const budget = toSummaryBudget(settings);
  const summaryText = buildResultSummary(payloadItems, manifest.manifestPath, budget);

  return {
    summaryText,
    callDir: context.callDir,
    manifestPath: manifest.manifestPath,
    payloadItems,
    payloadItemIndexes: manifest.payloadItemIndexes,
    mainFiles: payloadItems.map((item) => item.path),
    metaFiles: [manifest.manifestPath],
    budget,
  };
}
