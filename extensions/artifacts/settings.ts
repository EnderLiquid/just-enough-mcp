import type { MaterializationSettings, ResultPresentationSettings, TuiResultRenderSettings } from "./types.js";

export function toMaterializationSettings(settings: ResultPresentationSettings | undefined): MaterializationSettings | undefined {
  if (!settings) {
    return undefined;
  }

  return {
    artifactRoot: settings.artifactRoot,
    summaryItemCount: settings.summaryItemCount,
    previewFullCharsPerItem: settings.previewFullCharsPerItem,
    previewTruncateToCharsPerItem: settings.previewTruncateToCharsPerItem,
    hardMaxChars: settings.hardMaxChars,
    prettyPrintJson: settings.prettyPrintJson,
  };
}

export function toTuiResultRenderSettings(settings: ResultPresentationSettings | undefined): TuiResultRenderSettings | undefined {
  if (!settings) {
    return undefined;
  }

  return {
    collapsedPreviewLines: settings.collapsedPreviewLines,
  };
}
