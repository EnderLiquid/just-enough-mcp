import { loadRawPluginConfigFromPaths, resolveCorePluginConfig } from "../../core/config/plugin-config.js";
import {
  DEFAULT_TUI_RESULT_RENDER_SETTINGS,
  type McpTuiRenderMode,
  type TuiResultRenderSettings,
} from "../rendering/types.js";
import type { PluginConfigLoadResult } from "./types.js";

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

export function loadPluginConfigFromPaths(
  configPaths: readonly string[],
  overviewDir: string,
  artifactDir: string,
): PluginConfigLoadResult {
  const raw = loadRawPluginConfigFromPaths(configPaths);
  return {
    ...resolveCorePluginConfig(raw, overviewDir),
    artifactDir,
    tui: parseTui(raw.raw.tui),
  };
}
