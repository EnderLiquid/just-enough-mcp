import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPluginConfig } from "../config/plugin-config.js";
import { buildFooterStatus } from "../rendering/footer-status.js";
import { createClientRegistry, type ClientRegistry, type ClientRegistrySnapshot } from "./registry.js";

const STATUS_KEY = "just-enough-mcp";

export interface McpRuntime {
  sync(): Promise<ClientRegistrySnapshot>;
  snapshot(): ClientRegistrySnapshot;
  registry(): ClientRegistry;
  refreshFooter(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void;
  closeAll(): Promise<void>;
}

function createRuntime(): McpRuntime {
  const registry = createClientRegistry();

  function snapshot(): ClientRegistrySnapshot {
    return registry.getSnapshot();
  }

  function refreshFooter(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
    if (!ctx.hasUI) return;
    const current = snapshot();
    ctx.ui.setStatus(STATUS_KEY, buildFooterStatus(current.connectedCount, current.totalCount).text);
  }

  return {
    async sync() {
      const config = loadPluginConfig();
      await registry.syncConfig(config);
      return snapshot();
    },
    snapshot,
    registry: () => registry,
    refreshFooter,
    async closeAll() {
      await registry.closeAll();
    },
  };
}

let sharedRuntime: McpRuntime | undefined;

export function getMcpRuntime(): McpRuntime {
  sharedRuntime ??= createRuntime();
  return sharedRuntime;
}
