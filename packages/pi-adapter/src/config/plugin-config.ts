import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  resolveCorePluginConfig,
  type RawCorePluginConfig,
} from "@enderliquid/just-enough-mcp";
import {
  DEFAULT_TUI_RESULT_RENDER_SETTINGS,
  type McpTuiRenderMode,
  type TuiResultRenderSettings,
} from "../rendering/types.js";
import type { PluginConfigLoadResult } from "./types.js";

interface RawPluginConfig extends RawCorePluginConfig {
  /** Pi-specific settings are intentionally opaque to Core. */
  tui?: unknown;
}

export interface RawPluginConfigSnapshot {
  configPaths: string[];
  raw: RawPluginConfig;
  resolutionConfigPath: string;
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

function ensureTuiRenderMode(value: unknown): McpTuiRenderMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "hidden" && value !== "minimal" && value !== "expanded") {
    throw new Error("just-enough-mcp config field \"tui.renderMode\" must be \"hidden\", \"minimal\", or \"expanded\".");
  }
  return value;
}

function parseTui(raw: unknown): TuiResultRenderSettings {
  if (raw === undefined) {
    return { ...DEFAULT_TUI_RESULT_RENDER_SETTINGS };
  }

  if (!isObject(raw)) {
    throw new Error("just-enough-mcp config field \"tui\" must be an object.");
  }

  return {
    renderMode: ensureTuiRenderMode(raw.renderMode) ?? DEFAULT_TUI_RESULT_RENDER_SETTINGS.renderMode,
    expandedModeCollapsedLines: ensurePositiveInteger(raw.expandedModeCollapsedLines, "tui.expandedModeCollapsedLines")
      ?? DEFAULT_TUI_RESULT_RENDER_SETTINGS.expandedModeCollapsedLines,
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

export function loadPluginConfigFromPaths(
  configPaths: readonly string[],
  overviewDir: string,
  artifactDir: string,
): PluginConfigLoadResult {
  const snapshot = loadRawPluginConfigFromPaths(configPaths);
  return {
    ...resolveCorePluginConfig(snapshot.raw, {
      overviewDir,
      configPath: snapshot.resolutionConfigPath,
    }),
    configPaths: snapshot.configPaths,
    artifactDir,
    tui: parseTui(snapshot.raw.tui),
  };
}
