import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentPluginConfig, installCurrentPluginConfig } from "./config/current-config.js";
import {
  createOverviewBootstrapper,
  installCurrentOverviewBootstrapper,
  type OverviewBootstrapper,
} from "./config/overview-bootstrapper.js";
import { loadPluginConfig } from "./config/plugin-config.js";
import type { PluginConfigLoadResult } from "./modeling/types.js";
import { createServerOverviewPrompt } from "./prompting/system-prompt.js";
import { installFooterStatusSink, refreshFooterStatus, updateFooterStatus } from "./rendering/footer-status.js";
import { installNotifierSink, notifyError, notifyInfo } from "./rendering/notifier.js";
import { installCurrentServerRegistry } from "./servers/current-registry.js";
import { createServerRegistry, type ServerRegistry } from "./servers/registry.js";
import { registerMcpServerTool } from "./tools/mcp-server-tool.js";
import { registerMcpTool } from "./tools/mcp-tool.js";

interface ActivePluginSession {
  config: PluginConfigLoadResult;
  registry: ServerRegistry;
  bootstrapper: OverviewBootstrapper;
  disposeConfig: () => void;
  disposeRegistry: () => void;
  disposeBootstrapper: () => void;
}

export default function justEnoughMcp(pi: ExtensionAPI): void {
  let activeSession: ActivePluginSession | undefined;
  let disposeNotifier: (() => void) | undefined;
  let disposeFooter: (() => void) | undefined;

  registerMcpServerTool(pi);
  registerMcpTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    disposeNotifier = installNotifierSink(
      ctx.hasUI ? { notify: ctx.ui.notify.bind(ctx.ui) } : undefined,
    );
    const footer = ctx.hasUI
      ? { setStatus: ctx.ui.setStatus.bind(ctx.ui) }
      : undefined;

    disposeFooter = installFooterStatusSink(footer);

    let config: PluginConfigLoadResult | undefined;
    let registry: ServerRegistry | undefined;
    let bootstrapper: OverviewBootstrapper | undefined;
    let disposeBootstrapper: (() => void) | undefined;
    let disposeConfig: (() => void) | undefined;
    let disposeRegistry: (() => void) | undefined;

    try {
      config = loadPluginConfig();
      bootstrapper = createOverviewBootstrapper({
        overviewDir: config.overviewDir,
        onCreated: serverName => notifyInfo(`Created MCP overview stub: ${serverName}`),
      });
      disposeBootstrapper = installCurrentOverviewBootstrapper(bootstrapper);

      registry = createServerRegistry(config.servers);
      await registry.initialize();

      disposeConfig = installCurrentPluginConfig(config);
      disposeRegistry = installCurrentServerRegistry(registry);
      activeSession = {
        config,
        registry,
        bootstrapper,
        disposeConfig,
        disposeRegistry,
        disposeBootstrapper,
      };
    } catch (error) {
      activeSession = undefined;
      disposeRegistry?.();
      disposeConfig?.();
      await registry?.closeAll().catch(() => undefined);
      disposeBootstrapper?.();
      await bootstrapper?.close().catch(() => undefined);

      const message = error instanceof Error ? error.message : String(error);
      notifyError(`just-enough-mcp config error: ${message}`);
      updateFooterStatus(0, 0);
      return;
    }

    try {
      await refreshFooterStatus(registry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyError(`just-enough-mcp config error: ${message}`);
      updateFooterStatus(0, 0);
    }
  });

  pi.on("before_agent_start", async (event) => {
    const config = getCurrentPluginConfig();

    if (!config) {
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n# MCP Servers\n\n` +
          "just-enough-mcp has not loaded its configuration for this session yet. Use /reload if needed.",
      };
    }

    const injectedPrompt = createServerOverviewPrompt(config);
    return {
      systemPrompt: `${event.systemPrompt}\n\n# MCP Servers\n\n${injectedPrompt}`,
    };
  });

  pi.on("session_shutdown", async () => {
    const session = activeSession;
    activeSession = undefined;

    try {
      if (session) {
        session.disposeRegistry();
        session.disposeConfig();
        try {
          await session.registry.closeAll();
        } finally {
          session.disposeBootstrapper();
          await session.bootstrapper.close();
        }
      }
    } finally {
      disposeFooter?.();
      disposeFooter = undefined;
      disposeNotifier?.();
      disposeNotifier = undefined;
    }
  });
}
