import type { MaterializationSettings, StoredPayloadItem, SummaryBudget } from "./types.js";

interface TextPreviewResult {
  lines: string[];
  truncated: boolean;
}

function buildTextPreview(
  text: string,
  previewFullChars: number,
  previewTruncateToChars: number,
): TextPreviewResult {
  // `text` is expected to be normalized already (`\r\n` -> `\n`).

  if (text.trimEnd() === "") {
    return { lines: ["(empty text)"], truncated: false };
  }

  if (text.length <= previewFullChars) {
    return {
      lines: text.split("\n"),
      truncated: false,
    };
  }

  let actualPreviewTruncateToChars: number = previewTruncateToChars;
  while (actualPreviewTruncateToChars > 0 && text[actualPreviewTruncateToChars - 1] === "\n") {
    actualPreviewTruncateToChars -= 1;
  }

  const totalLines = text.split("\n").length;
  const visibleText = text.slice(0, actualPreviewTruncateToChars);
  const visibleLines = visibleText.split("\n").length;
  const truncatedInLine = text[visibleText.length] !== "\n" && text[visibleText.length] !== undefined;

  const remainingChars = text.length - visibleText.length;
  // Counts how many line fragments the remaining text spans.
  // When truncation happens in-line, the unfinished tail of the current line counts as one remaining line.
  const remainingLines = totalLines - visibleLines + (truncatedInLine ? 1 : 0);

  const previewLines = visibleText.split("\n");
  const remainderSummary = `${remainingChars} more chars across ${remainingLines} lines of remaining text`;

  if (truncatedInLine) {
    previewLines[previewLines.length - 1] = `${previewLines[previewLines.length - 1]}… ⟦TRUNCATED⟧`;
    previewLines.push(remainderSummary);
    return { lines: previewLines, truncated: true };
  }

  previewLines.push(`… ${remainderSummary}`);
  return { lines: previewLines, truncated: true };
}

function buildItemPreview(item: StoredPayloadItem, settings: Pick<MaterializationSettings, "previewFullCharsPerItem" | "previewTruncateToCharsPerItem">): string[] {
  if (item.text === undefined) {
    return [`File: ${item.path}`];
  }

  const preview = buildTextPreview(item.text, settings.previewFullCharsPerItem, settings.previewTruncateToCharsPerItem);
  if (!preview.truncated) {
    return preview.lines;
  }

  return [...preview.lines, `Full output: ${item.path}`];
}

function toDisplayLabel(item: StoredPayloadItem): string {
  if (item.source === "structuredContent") {
    return "structuredContent";
  }

  return item.contentType ?? "unknown";
}

function joinSections(sections: string[][]): string {
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

function buildSummary(payloadItems: StoredPayloadItem[], manifestPath: string, budget: SummaryBudget): string {
  if (payloadItems.length === 0) {
    return "(empty result)\n";
  }

  if (payloadItems.length === 1) {
    return `${(payloadItems[0].preview ?? []).join("\n")}\n`;
  }

  const sections: string[][] = [];
  const displayedItems = payloadItems.slice(0, budget.summaryItemCount);

  for (const item of displayedItems) {
    sections.push([`[${item.index}] ${toDisplayLabel(item)}`, ...(item.preview ?? [])]);
  }

  if (payloadItems.length > displayedItems.length) {
    sections.push([`… and ${payloadItems.length - displayedItems.length} more payload items; inspect manifest.json`]);
  }

  sections.push([`Read manifest for full index: ${manifestPath}`]);
  return joinSections(sections);
}

function applyHardMax(summaryText: string, hardMaxChars: number, manifestPath: string): string {
  if (summaryText.length <= hardMaxChars) {
    return summaryText;
  }

  const tail = `\n\n…\nHard output limit reached; inspect manifest: ${manifestPath}\n`;
  const budget = Math.max(0, hardMaxChars - tail.length);
  return `${summaryText.slice(0, budget).trimEnd()}${tail}`;
}

export function attachPayloadPreviews(
  items: StoredPayloadItem[],
  settings: Pick<MaterializationSettings, "previewFullCharsPerItem" | "previewTruncateToCharsPerItem">,
): StoredPayloadItem[] {
  return items.map(item => ({
    ...item,
    preview: buildItemPreview(item, settings),
  }));
}

export function buildResultSummary(payloadItems: StoredPayloadItem[], manifestPath: string, budget: SummaryBudget): string {
  return applyHardMax(buildSummary(payloadItems, manifestPath, budget), budget.hardMaxChars, manifestPath);
}
