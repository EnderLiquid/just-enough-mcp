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
  type PreparedToolCallResult,
  type SummaryBudget,
} from "./types.js";

export interface PrepareToolCallResultInput {
  result: CallToolResult;
  settings?: Partial<Pick<MaterializationSettings, "prettyPrintJson">>;
}

export interface MaterializeCallToolResultInput {
  artifactDir: string;
  server: string;
  tool: string;
  result: CallToolResult;
  settings?: Partial<MaterializationSettings>;
}

export interface MaterializePreparedToolCallResultInput {
  artifactDir: string;
  server: string;
  tool: string;
  prepared: PreparedToolCallResult;
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

export function prepareToolCallResult(
  input: PrepareToolCallResultInput,
): PreparedToolCallResult {
  const extracted = extractPayloadDrafts(input.result);
  return normalizePayloadDrafts(extracted, {
    prettyPrintJson: input.settings?.prettyPrintJson
      ?? DEFAULT_MATERIALIZATION_SETTINGS.prettyPrintJson,
  });
}

export function materializePreparedToolCallResult(
  input: MaterializePreparedToolCallResultInput,
): MaterializedToolCallResult {
  const settings: MaterializationSettings = {
    ...DEFAULT_MATERIALIZATION_SETTINGS,
    ...(input.settings ?? {}),
  };
  const budget = toSummaryBudget(settings);
  const context = createArtifactContext({
    artifactDir: input.artifactDir,
    server: input.server,
  });

  try {
    const storedItems = storePayloadItems(input.prepared.items, context);
    const manifest = writeToolCallManifest({
      server: input.server,
      tool: input.tool,
      context,
      payloadItems: storedItems,
      suppressedStructuredContent: input.prepared.suppressedStructuredContent,
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

export function materializeToolCallResult(
  input: MaterializeCallToolResultInput,
): MaterializedToolCallResult {
  const prepared = prepareToolCallResult({
    result: input.result,
    settings: input.settings,
  });
  return materializePreparedToolCallResult({
    artifactDir: input.artifactDir,
    server: input.server,
    tool: input.tool,
    prepared,
    settings: input.settings,
  });
}
