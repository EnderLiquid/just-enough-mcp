import { existsSync, readFileSync } from "node:fs";
import { getOverviewDirectoryPath, getPluginConfigPath } from "./paths.js";
import { loadServerOverview } from "./server-overviews.js";
import {
  DEFAULT_CONNECTION_MODE,
  type PluginConfigLoadResult,
  type RawPluginConfig,
  type ResolvedServerConfig,
  type ServerConfig,
} from "../modeling/types.js";
import {
  DEFAULT_RESULT_PRESENTATION_SETTINGS,
  type ResultPresentationSettings,
} from "../modeling/materialization.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureStringArray(value: unknown, fieldName: string, serverName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`Server \"${serverName}\" field \"${fieldName}\" must be an array of strings.`);
  }
  return value;
}

function ensureStringRecord(value: unknown, fieldName: string, serverName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some(item => typeof item !== "string")) {
    throw new Error(`Server \"${serverName}\" field \"${fieldName}\" must be an object of string values.`);
  }
  return value as Record<string, string>;
}

function ensurePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`just-enough-mcp config field \"resultPresentation.${fieldName}\" must be a positive integer.`);
  }
  return value;
}

function ensureBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`just-enough-mcp config field \"resultPresentation.${fieldName}\" must be a boolean.`);
  }
  return value;
}

function ensureNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`just-enough-mcp config field \"resultPresentation.${fieldName}\" must be a non-empty string.`);
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

  return {
    artifactRoot: ensureNonEmptyString(raw.artifactRoot, "artifactRoot") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.artifactRoot,
    summaryItemCount: ensurePositiveInteger(raw.summaryItemCount, "summaryItemCount") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.summaryItemCount,
    previewLinesPerItem: ensurePositiveInteger(raw.previewLinesPerItem, "previewLinesPerItem") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.previewLinesPerItem,
    previewCharsPerItem: ensurePositiveInteger(raw.previewCharsPerItem, "previewCharsPerItem") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.previewCharsPerItem,
    hardMaxChars: ensurePositiveInteger(raw.hardMaxChars, "hardMaxChars") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.hardMaxChars,
    prettyPrintJson: ensureBoolean(raw.prettyPrintJson, "prettyPrintJson") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.prettyPrintJson,
    collapsedPreviewLines: ensurePositiveInteger(raw.collapsedPreviewLines, "collapsedPreviewLines") ?? DEFAULT_RESULT_PRESENTATION_SETTINGS.collapsedPreviewLines,
  };
}

function parseServerConfig(serverName: string, raw: unknown): ServerConfig {
  if (!isObject(raw)) {
    throw new Error(`Server \"${serverName}\" config must be an object.`);
  }

  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Server \"${serverName}\" must set transport to \"stdio\" or \"http\".`);
  }

  const connectionMode = raw.connectionMode;
  if (
    connectionMode !== undefined &&
    connectionMode !== "lazy" &&
    connectionMode !== "eager"
  ) {
    throw new Error(`Server \"${serverName}\" connectionMode must be \"lazy\" or \"eager\".`);
  }

  const overview = raw.overview;
  if (overview !== undefined && typeof overview !== "string") {
    throw new Error(`Server \"${serverName}\" overview must be a string path.`);
  }

  if (transport === "stdio") {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      throw new Error(`Server \"${serverName}\" must provide a non-empty command for stdio transport.`);
    }

    return {
      transport,
      command: raw.command,
      args: ensureStringArray(raw.args, "args", serverName),
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      env: ensureStringRecord(raw.env, "env", serverName),
      connectionMode,
      overview,
    };
  }

  if (typeof raw.url !== "string" || raw.url.length === 0) {
    throw new Error(`Server \"${serverName}\" must provide a non-empty url for http transport.`);
  }

  if (raw.bearerToken !== undefined && typeof raw.bearerToken !== "string") {
    throw new Error(`Server \"${serverName}\" bearerToken must be a string.`);
  }

  return {
    transport,
    url: raw.url,
    headers: ensureStringRecord(raw.headers, "headers", serverName),
    bearerToken: typeof raw.bearerToken === "string" ? raw.bearerToken : undefined,
    connectionMode,
    overview,
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

  return entries.map(([serverName, rawServer]) => {
    const parsed = parseServerConfig(serverName, rawServer);
    const overview = loadServerOverview(serverName, parsed, configPath, overviewDir);
    const { overview: _configuredOverviewPath, ...transportConfig } = parsed;

    return {
      ...transportConfig,
      name: serverName,
      connectionMode: parsed.connectionMode ?? DEFAULT_CONNECTION_MODE,
      hasExplicitOverviewConfig: typeof parsed.overview === "string",
      overviewPath: overview.path,
      overview,
    };
  });
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
