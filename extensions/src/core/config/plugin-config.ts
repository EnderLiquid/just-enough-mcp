import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadServerOverview } from "../overview/server-overviews.js";
import {
  DEFAULT_CONNECTION_MODE,
  type ResolvedServerConfig,
  type ServerConnectionMode,
} from "../modeling/types.js";
import {
  DEFAULT_MATERIALIZATION_SETTINGS,
  type MaterializationSettings,
} from "../artifacts/types.js";

export interface RawPluginConfig {
  materialization?: unknown;
  /** Host-specific settings remain opaque to Core configuration resolution. */
  tui?: unknown;
  servers?: Record<string, unknown | null>;
}

export interface RawPluginConfigSnapshot {
  configPaths: string[];
  raw: RawPluginConfig;
  resolutionConfigPath: string;
}

export interface CorePluginConfigLoadResult {
  configPaths: string[];
  overviewDir: string;
  materialization: MaterializationSettings;
  servers: ResolvedServerConfig[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensurePositiveInteger(value: unknown, fieldPath: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`just-enough-mcp config field "${fieldPath}" must be a positive integer.`);
  }
  return value;
}

function ensureBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`just-enough-mcp config field "${fieldPath}" must be a boolean.`);
  }
  return value;
}

function ensureNonEmptyString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`just-enough-mcp config field "${fieldPath}" must be a non-empty string.`);
  }
  return value;
}

function parseMaterialization(raw: unknown): MaterializationSettings {
  if (raw === undefined) {
    return { ...DEFAULT_MATERIALIZATION_SETTINGS };
  }

  if (!isObject(raw)) {
    throw new Error("just-enough-mcp config field \"materialization\" must be an object.");
  }

  const previewFullCharsPerItem = ensurePositiveInteger(raw.previewFullCharsPerItem, "materialization.previewFullCharsPerItem")
    ?? DEFAULT_MATERIALIZATION_SETTINGS.previewFullCharsPerItem;
  const previewTruncateToCharsPerItem = ensurePositiveInteger(raw.previewTruncateToCharsPerItem, "materialization.previewTruncateToCharsPerItem")
    ?? DEFAULT_MATERIALIZATION_SETTINGS.previewTruncateToCharsPerItem;

  if (previewTruncateToCharsPerItem > previewFullCharsPerItem) {
    throw new Error("just-enough-mcp config field \"materialization.previewTruncateToCharsPerItem\" must be smaller than \"materialization.previewFullCharsPerItem\".");
  }

  return {
    summaryItemCount: ensurePositiveInteger(raw.summaryItemCount, "materialization.summaryItemCount") ?? DEFAULT_MATERIALIZATION_SETTINGS.summaryItemCount,
    previewFullCharsPerItem,
    previewTruncateToCharsPerItem,
    hardMaxChars: ensurePositiveInteger(raw.hardMaxChars, "materialization.hardMaxChars") ?? DEFAULT_MATERIALIZATION_SETTINGS.hardMaxChars,
    prettyPrintJson: ensureBoolean(raw.prettyPrintJson, "materialization.prettyPrintJson") ?? DEFAULT_MATERIALIZATION_SETTINGS.prettyPrintJson,
  };
}

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function assertValidServerName(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(
      `MCP server name "${serverName}" must be 1 to 32 lowercase ASCII letters, digits, ".", "_" or "-", beginning with a letter or digit.`,
    );
  }

  const firstSegment = serverName.split(".", 1)[0]!;
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(firstSegment)) {
    throw new Error(`MCP server name "${serverName}" uses the Windows-reserved device name "${firstSegment}".`);
  }
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
    overview: resolvedOverview,
    definition,
  };
}

function normalizeOverviewPaths(configPath: string, raw: RawPluginConfig): RawPluginConfig {
  if (raw.servers === undefined) {
    return raw;
  }

  const servers: Record<string, unknown | null> = {};
  for (const [serverName, rawServer] of Object.entries(raw.servers)) {
    if (
      !isObject(rawServer)
      || typeof rawServer.overview !== "string"
      || rawServer.overview.length === 0
      || isAbsolute(rawServer.overview)
    ) {
      servers[serverName] = rawServer;
      continue;
    }

    servers[serverName] = {
      ...rawServer,
      overview: resolve(dirname(configPath), rawServer.overview),
    };
  }

  return { ...raw, servers };
}

function parseRawConfig(configPath: string): RawPluginConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const rawText = readFileSync(configPath, "utf8");
  const parsed: unknown = JSON.parse(rawText);
  if (!isObject(parsed)) {
    throw new Error(`just-enough-mcp config "${configPath}" must be a JSON object.`);
  }

  if (parsed.servers !== undefined && !isObject(parsed.servers)) {
    throw new Error(`just-enough-mcp config field "servers" in "${configPath}" must be an object.`);
  }

  return normalizeOverviewPaths(configPath, parsed as RawPluginConfig);
}

function mergeConfigField(previous: unknown, next: unknown): unknown {
  if (isObject(previous) && isObject(next)) {
    return { ...previous, ...next };
  }
  return next;
}

function mergeRawConfigs(layers: readonly RawPluginConfig[]): RawPluginConfig {
  const merged: RawPluginConfig = {};

  for (const layer of layers) {
    if (layer.materialization !== undefined) {
      merged.materialization = mergeConfigField(merged.materialization, layer.materialization);
    }
    if (layer.tui !== undefined) {
      merged.tui = mergeConfigField(merged.tui, layer.tui);
    }
    if (layer.servers !== undefined) {
      const servers = { ...(merged.servers ?? {}) };
      for (const [serverName, rawServer] of Object.entries(layer.servers)) {
        if (rawServer === null) {
          delete servers[serverName];
        } else {
          servers[serverName] = rawServer;
        }
      }
      merged.servers = servers;
    }
  }

  return merged;
}

function resolveServers(configPath: string, overviewDir: string, raw: RawPluginConfig): ResolvedServerConfig[] {
  const entries = Object.entries(raw.servers ?? {});
  return entries.map(([serverName, rawServer]) => {
    assertValidServerName(serverName);
    return parseResolvedServerConfig(serverName, rawServer, configPath, overviewDir);
  });
}

export function loadRawPluginConfigFromPaths(
  configPaths: readonly string[],
): RawPluginConfigSnapshot {
  const normalizedConfigPaths = configPaths.map(configPath => resolve(configPath));
  return {
    configPaths: normalizedConfigPaths,
    raw: mergeRawConfigs(normalizedConfigPaths.map(parseRawConfig)),
    resolutionConfigPath: normalizedConfigPaths.at(-1) ?? "",
  };
}

export function resolveCorePluginConfig(
  snapshot: RawPluginConfigSnapshot,
  overviewDir: string,
): CorePluginConfigLoadResult {
  return {
    configPaths: snapshot.configPaths,
    overviewDir,
    materialization: parseMaterialization(snapshot.raw.materialization),
    servers: resolveServers(snapshot.resolutionConfigPath, overviewDir, snapshot.raw),
  };
}

export function loadPluginConfigFromPaths(
  configPaths: readonly string[],
  overviewDir: string,
): CorePluginConfigLoadResult {
  return resolveCorePluginConfig(
    loadRawPluginConfigFromPaths(configPaths),
    overviewDir,
  );
}
