import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPluginConfig } from "../config/plugin-config.js";
import { tryBootstrapOverviewFromDescription } from "../config/overview-bootstrap.js";
import type { PluginConfigLoadResult } from "../modeling/types.js";
import { buildFooterStatus } from "../rendering/footer-status.js";
import { createServerRegistry, type ServerReadyEvent, type ServerRegistry, type ServerRegistryStatus } from "./registry.js";
import { notifyInfo } from "../ui/notifier.js";

const STATUS_KEY = "just-enough-mcp";

export interface McpRuntime {
  sync(): Promise<ServerRegistryStatus>;
  config: () => PluginConfigLoadResult | undefined;
  getStatus: () => ServerRegistryStatus;
  registry: () => ServerRegistry;
  refreshFooter(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void;
  closeAll(): Promise<void>;
}

function createRuntime(): McpRuntime {
  let loadedConfig: PluginConfigLoadResult | undefined;

  async function handleServerReady(event: ServerReadyEvent): Promise<void> {
    if (!loadedConfig) {
      return;
    }

    try {
      const bootstrapResult = tryBootstrapOverviewFromDescription(
        event.config,
        loadedConfig.overviewDir,
        event.description,
      );

      if (bootstrapResult?.created) {
        notifyInfo(`Created MCP overview stub: ${event.config.name}`);
      }
    } catch {
    }
  }

  const registry = createServerRegistry({
    onServerReady: handleServerReady,
  });

  function getStatus(): ServerRegistryStatus {
    return registry.getStatus();
  }

  function refreshFooter(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
    if (!ctx.hasUI) return;
    const current = getStatus();
    ctx.ui.setStatus(STATUS_KEY, buildFooterStatus(current.connectedCount, current.totalCount).text);
  }

  return {
    async sync() {
      loadedConfig = loadPluginConfig();
      await registry.syncConfig(loadedConfig);
      return getStatus();
    },
    config: () => loadedConfig,
    getStatus,
    registry: () => registry,
    refreshFooter,
    async closeAll() {
      await registry.closeAll();
      loadedConfig = undefined;
    },
  };
}

let sharedRuntime: McpRuntime | undefined;

export function getMcpRuntime(): McpRuntime {
  sharedRuntime ??= createRuntime();
  return sharedRuntime;
}
