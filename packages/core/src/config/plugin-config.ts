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

export interface RawCorePluginConfig {
  materialization?: unknown;
  servers?: Record<string, unknown | null>;
}

export interface CorePluginConfigResolveOptions {
  readonly overviewDir: string;
  /**
   * Base config path used for a relative explicit overview path.
   * Host adapters are responsible for deciding how configuration paths are resolved.
   */
  readonly configPath?: string;
}

export interface CorePluginConfigLoadResult {
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

function resolveServers(
  configPath: string,
  overviewDir: string,
  raw: RawCorePluginConfig,
): ResolvedServerConfig[] {
  const entries = Object.entries(raw.servers ?? {});
  return entries.map(([serverName, rawServer]) => {
    assertValidServerName(serverName);
    return parseResolvedServerConfig(serverName, rawServer, configPath, overviewDir);
  });
}

export function resolveCorePluginConfig(
  raw: RawCorePluginConfig,
  options: CorePluginConfigResolveOptions,
): CorePluginConfigLoadResult {
  return {
    overviewDir: options.overviewDir,
    materialization: parseMaterialization(raw.materialization),
    servers: resolveServers(options.configPath ?? "", options.overviewDir, raw),
  };
}
