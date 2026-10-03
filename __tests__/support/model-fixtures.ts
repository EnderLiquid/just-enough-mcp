import {
  DEFAULT_MATERIALIZATION_SETTINGS,
} from "../../packages/core/src/artifacts/types.js";
import { resolveCorePluginConfig } from "../../packages/core/src/config/plugin-config.js";
import { DEFAULT_TUI_RESULT_RENDER_SETTINGS } from "../../packages/pi-adapter/src/rendering/types.js";
import type { PluginConfigLoadResult } from "../../packages/pi-adapter/src/config/types.js";
import type {
  ResolvedServerConfig,
  ServerDefinition,
  ServerSnapshot,
} from "../../packages/core/src/modeling/types.js";

type ResolvedServerConfigOverrides = Partial<ResolvedServerConfig> & {
  /** 测试中允许使用 raw definition 快速构造 resolved model。 */
  definition?: ServerDefinition;
};

export function makeResolvedServerConfig(
  overrides: ResolvedServerConfigOverrides = {},
): ResolvedServerConfig {
  const name = overrides.name ?? "demo";
  let parsed: ResolvedServerConfig | undefined;
  let parseWarning: string | undefined;
  if (overrides.definition !== undefined) {
    const resolved = resolveCorePluginConfig(
      { servers: { [name]: overrides.definition } },
      { overviewDirectoryPath: "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews" },
    );
    parsed = resolved.servers[0];
    parseWarning = resolved.warnings[0]?.message;
  }

  if (overrides.definition !== undefined && parsed === undefined) {
    throw new Error(parseWarning ?? `测试 server "${name}" 的 definition 无法解析。`);
  }

  const defaults: ResolvedServerConfig = parsed ?? {
    name,
    connectionMode: "lazy",
    overview: {
      name,
      content: "No overview configured yet.",
      source: "none",
    },
    transport: {
      kind: "stdio",
      command: "npx",
    },
    toolFilter: {
      include: [],
      exclude: [],
    },
  };
  const { definition: _definition, ...resolvedOverrides } = overrides;

  return {
    ...defaults,
    ...resolvedOverrides,
    overview: { ...(resolvedOverrides.overview ?? defaults.overview) },
    transport: resolvedOverrides.transport ?? defaults.transport,
    toolFilter: resolvedOverrides.toolFilter ?? defaults.toolFilter,
  };
}

export function makePluginConfig(
  overrides: Partial<PluginConfigLoadResult> = {},
): PluginConfigLoadResult {
  const servers = overrides.servers ?? [makeResolvedServerConfig()];

  return {
    configPaths: ["C:/Users/Admin/.pi/agent/just-enough-mcp/config.json"],
    overviewDirectoryPath: "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews",
    artifactDirectoryPath: "C:/Users/Admin/.pi/agent/just-enough-mcp/artifacts",
    warnings: [],
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
