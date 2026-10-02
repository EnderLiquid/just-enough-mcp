import {
  DEFAULT_MATERIALIZATION_SETTINGS,
} from "../../packages/core/src/artifacts/types.js";
import { DEFAULT_TUI_RESULT_RENDER_SETTINGS } from "../../packages/pi-adapter/src/rendering/types.js";
import type { PluginConfigLoadResult } from "../../packages/pi-adapter/src/config/types.js";
import type {
  ResolvedServerConfig,
  ServerSnapshot,
} from "../../packages/core/src/modeling/types.js";

export function makeResolvedServerConfig(
  overrides: Partial<ResolvedServerConfig> = {},
): ResolvedServerConfig {
  const name = overrides.name ?? "demo";
  const defaults: ResolvedServerConfig = {
    name,
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: {
      name,
      content: "No overview configured yet.",
      source: "none",
    },
    definition: {
      command: "npx",
    },
  };

  return {
    ...defaults,
    ...overrides,
    overview: { ...(overrides.overview ?? defaults.overview) },
    definition: { ...(overrides.definition ?? defaults.definition) },
  };
}

export function makePluginConfig(
  overrides: Partial<PluginConfigLoadResult> = {},
): PluginConfigLoadResult {
  const servers = overrides.servers ?? [makeResolvedServerConfig()];

  return {
    configPaths: ["C:/Users/Admin/.pi/agent/just-enough-mcp/config.json"],
    overviewDir: "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews",
    artifactDir: "C:/Users/Admin/.pi/agent/just-enough-mcp/artifacts",
    ...overrides,
    materialization: { ...(overrides.materialization ?? DEFAULT_MATERIALIZATION_SETTINGS) },
    tui: { ...(overrides.tui ?? DEFAULT_TUI_RESULT_RENDER_SETTINGS) },
    servers: servers.map(server => makeResolvedServerConfig(server)),
  };
}

export function makeServerSnapshot(
  overrides: Partial<ServerSnapshot> = {},
): ServerSnapshot {
  return {
    name: "demo",
    connectState: "connected",
    ...overrides,
  };
}
