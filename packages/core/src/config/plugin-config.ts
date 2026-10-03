import {
  assertAbsoluteConfiguredOverviewPath,
  resolveServerOverview
} from "../overview/server-overviews.js";
import {
  InvalidServerConfigError,
  assertValidServerName,
  parseServerConfig,
  toResolvedServerConfig,
} from "./server-config.js";
import {
  DEFAULT_MATERIALIZATION_SETTINGS,
  type MaterializationSettings,
} from "../artifacts/types.js";
import type { ResolvedServerConfig } from "../modeling/types.js";

export interface RawCorePluginConfig {
  materialization?: unknown;
  servers?: Record<string, unknown | null>;
}

export interface CorePluginConfigResolveOptions {
  /** 默认 overview 文件所在的目录。显式 overview 路径必须已由宿主 loader 规范化。 */
  readonly overviewDirectoryPath: string;
}

export type CorePluginConfigWarningCode =
  | "invalid-server-name"
  | "invalid-server-definition"
  | "overview-unavailable";

export interface CorePluginConfigWarning {
  readonly code: CorePluginConfigWarningCode;
  readonly serverName: string;
  readonly fieldPath?: string;
  readonly message: string;
  readonly action: "skipped" | "fallback";
}

export interface CorePluginConfigLoadResult {
  materialization: MaterializationSettings;
  servers: ResolvedServerConfig[];
  warnings: CorePluginConfigWarning[];
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

function resolveServers(
  overviewDirectoryPath: string,
  raw: RawCorePluginConfig,
): { servers: CorePluginConfigLoadResult["servers"]; warnings: CorePluginConfigWarning[] } {
  const servers: CorePluginConfigLoadResult["servers"] = [];
  const warnings: CorePluginConfigWarning[] = [];

  for (const [serverName, rawServer] of Object.entries(raw.servers ?? {})) {
    try {
      assertValidServerName(serverName);
      const parsed = parseServerConfig(serverName, rawServer);
      if (parsed.configuredOverviewPath !== undefined) {
        assertAbsoluteConfiguredOverviewPath(parsed.configuredOverviewPath);
      }
      const overviewResolution = resolveServerOverview(
        serverName,
        { overview: parsed.configuredOverviewPath },
        overviewDirectoryPath,
      );

      servers.push(toResolvedServerConfig(serverName, parsed, overviewResolution.overview));

      if (overviewResolution.warning !== undefined) {
        warnings.push({
          code: "overview-unavailable",
          serverName,
          fieldPath: "overview",
          message: overviewResolution.warning,
          action: "fallback",
        });
      }
    } catch (error) {
      if (!(error instanceof InvalidServerConfigError)) {
        throw error;
      }

      warnings.push({
        code: error.code,
        serverName,
        ...(error.fieldPath === undefined ? {} : { fieldPath: error.fieldPath }),
        message: error.message,
        action: "skipped",
      });
    }
  }

  return { servers, warnings };
}

export function resolveCorePluginConfig(
  raw: RawCorePluginConfig,
  options: CorePluginConfigResolveOptions,
): CorePluginConfigLoadResult {
  if (!isObject(raw)) {
    throw new Error("just-enough-mcp core config must be an object.");
  }
  if (raw.servers !== undefined && !isObject(raw.servers)) {
    throw new Error("just-enough-mcp config field \"servers\" must be an object.");
  }

  const materialization = parseMaterialization(raw.materialization);
  const resolvedServers = resolveServers(options.overviewDirectoryPath, raw);
  return {
    materialization,
    servers: resolvedServers.servers,
    warnings: resolvedServers.warnings,
  };
}
