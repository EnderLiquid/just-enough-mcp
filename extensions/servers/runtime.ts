import { loadPluginConfig } from "../config/plugin-config.js";
import { tryBootstrapOverviewFromDescription } from "../config/overview-bootstrap.js";
import type { PluginConfigLoadResult } from "../modeling/types.js";
import { updateFooterStatus } from "../rendering/footer-status.js";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";
import { createServerRegistry, type ServerReadyEvent, type ServerRegistry } from "./registry.js";
import { notifyInfo } from "../rendering/notifier.js";

export interface McpRuntime {
  sync(): Promise<void>;
  config: () => PluginConfigLoadResult | undefined;
  registry: () => ServerRegistry;
  refreshFooter(): Promise<void>;
  closeAll(): Promise<void>;
}

export function createRuntime(): McpRuntime {
  let loadedConfig: PluginConfigLoadResult | undefined;
  const lifecycleLock = new AsyncReadWriteLock();

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

  return {
    async sync() {
      return lifecycleLock.withWrite(async () => {
        loadedConfig = loadPluginConfig();
        await registry.syncConfig(loadedConfig);
      });
    },
    config: () => loadedConfig,
    registry: () => registry,
    async refreshFooter() {
      const current = await registry.getStatus();
      updateFooterStatus(current.connectedCount, current.totalCount);
    },
    async closeAll() {
      await lifecycleLock.withWrite(async () => {
        await registry.closeAll();
        loadedConfig = undefined;
      });
    },
  };
}

let sharedRuntime: McpRuntime | undefined;

export function getMcpRuntime(): McpRuntime {
  sharedRuntime ??= createRuntime();
  return sharedRuntime;
}
