import { existsSync, readFileSync } from "node:fs";
import { getOverviewDirectoryPath, getPluginConfigPath } from "./paths.js";
import { loadServerOverview } from "./server-overviews.js";
import {
  DEFAULT_CONNECTION_MODE,
  type PluginConfigLoadResult,
  type RawPluginConfig,
  type ResolvedServerConfig,
  type ServerConnectionMode,
} from "../modeling/types.js";
import {
  DEFAULT_RESULT_PRESENTATION_SETTINGS,
  type ResultPresentationSettings,
} from "../artifacts/types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensurePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`just-enough-mcp config field "resultPresentation.${fieldName}" must be a positive integer.`);
  }
  return value;
}

function ensureBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`just-enough-mcp config field "resultPresentation.${fieldName}" must be a boolean.`);
  }
  return value;
}

function ensureNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`just-enough-mcp config field "resultPresentation.${fieldName}" must be a non-empty string.`);
  }
  return value;
}

function parseResultPresentation(raw: unknown): ResultPresentationSettings {
  if (raw === undefined) {
    return { ...DEFAULT_RESULT_PRESENTATION_SETTINGS };
  }

  if (!isObject(raw)) {
    throw new Error("just-enough-mcp config field \"resultPresentation\" must be an object.");
  }

  const previewFullCharsPerItem = ensurePositiveInteger(raw.previewFullCharsPerItem, "previewFullCharsPerItem")
    ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.previewFullCharsPerItem;
  const previewTruncateToCharsPerItem = ensurePositiveInteger(raw.previewTruncateToCharsPerItem, "previewTruncateToCharsPerItem")
    ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.previewTruncateToCharsPerItem;

  if (previewTruncateToCharsPerItem > previewFullCharsPerItem) {
    throw new Error("just-enough-mcp config field \"resultPresentation.previewTruncateToCharsPerItem\" must be smaller than \"resultPresentation.previewFullCharsPerItem\".");
  }

  return {
    artifactRoot: ensureNonEmptyString(raw.artifactRoot, "artifactRoot") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.artifactRoot,
    summaryItemCount: ensurePositiveInteger(raw.summaryItemCount, "summaryItemCount") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.summaryItemCount,
    previewFullCharsPerItem,
    previewTruncateToCharsPerItem,
    hardMaxChars: ensurePositiveInteger(raw.hardMaxChars, "hardMaxChars") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.hardMaxChars,
    prettyPrintJson: ensureBoolean(raw.prettyPrintJson, "prettyPrintJson") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.prettyPrintJson,
    collapsedPreviewLines: ensurePositiveInteger(raw.collapsedPreviewLines, "collapsedPreviewLines") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.collapsedPreviewLines,
  };
}

function parseConnectionMode(value: unknown, serverName: string): ServerConnectionMode {
  if (value === undefined) {
    return DEFAULT_CONNECTION_MODE;
  }

  if (value !== "lazy" && value !== "eager") {
    throw new Error(`Server "${serverName}" connectionMode must be "lazy" or "eager".`);
  }

  return value;
}

function parseOverviewPath(value: unknown, serverName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Server "${serverName}" overview must be a string path.`);
  }

  return value;
}

function parseResolvedServerConfig(
  serverName: string,
  raw: unknown,
  configPath: string,
  overviewDir: string,
): ResolvedServerConfig {
  if (!isObject(raw)) {
    throw new Error(`Server "${serverName}" config must be an object.`);
  }

  const connectionMode = parseConnectionMode(raw.connectionMode, serverName);
  const overview = parseOverviewPath(raw.overview, serverName);
  const definition = { ...raw };
  const resolvedOverview = loadServerOverview(serverName, { connectionMode, overview }, configPath, overviewDir);

  return {
    name: serverName,
    connectionMode,
    hasExplicitOverviewConfig: typeof overview === "string",
    overviewPath: resolvedOverview.path,
    overview: resolvedOverview,
    definition,
  };
}

function parseRawConfig(configPath: string): RawPluginConfig {
  if (!existsSync(configPath)) {
    return { servers: {} };
  }

  const rawText = readFileSync(configPath, "utf8");
  const parsed: unknown = JSON.parse(rawText);
  if (!isObject(parsed)) {
    throw new Error("just-enough-mcp config must be a JSON object.");
  }

  if (parsed.servers !== undefined && !isObject(parsed.servers)) {
    throw new Error("just-enough-mcp config field \"servers\" must be an object.");
  }

  return parsed as RawPluginConfig;
}

function resolveServers(configPath: string, overviewDir: string, raw: RawPluginConfig): ResolvedServerConfig[] {
  const entries = Object.entries(raw.servers ?? {});
  return entries.map(([serverName, rawServer]) =>
    parseResolvedServerConfig(serverName, rawServer, configPath, overviewDir),
  );
}

export function loadPluginConfigFromPaths(configPath: string, overviewDir: string): PluginConfigLoadResult {
  const raw = parseRawConfig(configPath);
  const servers = resolveServers(configPath, overviewDir, raw);
  const resultPresentation = parseResultPresentation(raw.resultPresentation);

  return {
    configPath,
    overviewDir,
    resultPresentation,
    servers,
  };
}

export function loadPluginConfig(): PluginConfigLoadResult {
  return loadPluginConfigFromPaths(getPluginConfigPath(), getOverviewDirectoryPath());
}
