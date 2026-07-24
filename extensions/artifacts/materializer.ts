import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtifactTransactionCleanupError,
  commitArtifactContext,
  createArtifactContext,
  rollbackArtifactContext,
  storePayloadItems,
} from "./artifact-store.js";
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

  const extracted = extractPayloadDrafts(input.result);
  const normalized = normalizePayloadDrafts(extracted, settings);
  const budget = toSummaryBudget(settings);

  const context = createArtifactContext({
    cwd: input.cwd ?? process.cwd(),
    server: input.server,
    settings,
  });

  try {
    const storedItems = storePayloadItems(normalized.items, context);
    const manifest = writeToolCallManifest({
      server: input.server,
      tool: input.tool,
      context,
      payloadItems: storedItems,
      suppressedStructuredContent: normalized.suppressedStructuredContent,
    });
    const payloadItems = attachPayloadPreviews(storedItems, settings);
    const summaryText = buildResultSummary(payloadItems, manifest.manifestPath, budget);
    const materialized = {
      summaryText,
      callDir: context.callDir,
      manifestPath: manifest.manifestPath,
      payloadItems,
      manifestPayloadItems: manifest.payloadItems,
      mainFiles: payloadItems.map((item) => item.path),
      metaFiles: [manifest.manifestPath],
      budget,
    };

    commitArtifactContext(context);
    return materialized;
  } catch (error) {
    try {
      rollbackArtifactContext(context);
    } catch (cleanupError) {
      throw new ArtifactTransactionCleanupError(error, cleanupError, context.stagingDir);
    }
    throw error;
  }
}
