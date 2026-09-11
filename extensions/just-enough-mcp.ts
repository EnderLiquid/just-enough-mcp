import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getOAuthBrokerDirectoryPath } from "./config/paths.js";
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
import { installNotifierSink, notifyError, notifyInfo, notifyWarning } from "./rendering/notifier.js";
import { OAuthBrokerClient } from "./oauth/broker/client.js";
import {
  createOAuthBrokerBootstrapper,
  type OAuthBrokerBootstrapper,
} from "./oauth/broker/bootstrapper.js";
import { createOAuthBrokerNamespace } from "./oauth/broker/namespace.js";
import { DEFAULT_OAUTH_BROKER_PORT } from "./oauth/broker/protocol.js";
import { installCurrentServerRegistry } from "./servers/current-registry.js";
import { createServerRegistry, type ServerRegistry } from "./servers/registry.js";
import { registerMcpServerTool } from "./tools/mcp-server-tool.js";
import { registerMcpTool } from "./tools/mcp-tool.js";

interface ActivePluginSession {
  config: PluginConfigLoadResult;
  registry: ServerRegistry;
  bootstrapper: OverviewBootstrapper;
  oauthBroker?: {
    client: OAuthBrokerClient;
    launcher: OAuthBrokerBootstrapper;
    launchAbortController: AbortController;
    namespaceId: string;
  };
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
    let oauthBroker: ActivePluginSession["oauthBroker"];

    try {
      config = loadPluginConfig();
      if (config.servers.some(server => server.definition.auth === "oauth")) {
        const namespace = await createOAuthBrokerNamespace(getAgentDir());
        const launchAbortController = new AbortController();
        const client = new OAuthBrokerClient({
          rootDir: getOAuthBrokerDirectoryPath(),
          namespaceId: namespace.namespaceId,
          configuredPort: DEFAULT_OAUTH_BROKER_PORT,
        });
        const launcher = createOAuthBrokerBootstrapper({
          rootDir: getOAuthBrokerDirectoryPath(),
          namespaceId: namespace.namespaceId,
          requestedPort: DEFAULT_OAUTH_BROKER_PORT,
          client,
          signal: launchAbortController.signal,
          onWarning: (message, error) => notifyWarning(
            error instanceof Error ? `${message} ${error.message}` : message,
          ),
        });
        oauthBroker = {
          client,
          launcher,
          launchAbortController,
          namespaceId: namespace.namespaceId,
        };
        void launcher.start().catch(error => {
          if (!launchAbortController.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error);
            notifyWarning(`OAuth broker could not be bootstrapped: ${message}`);
          }
        });
      }

      bootstrapper = createOverviewBootstrapper({
        overviewDir: config.overviewDir,
        onCreated: serverName => notifyInfo(`Created MCP overview stub: ${serverName}`),
      });
      disposeBootstrapper = installCurrentOverviewBootstrapper(bootstrapper);

      registry = oauthBroker
        ? createServerRegistry(config.servers, {
            oauth: {
              brokerClient: oauthBroker.client,
              namespaceId: oauthBroker.namespaceId,
            },
          })
        : createServerRegistry(config.servers);
      await registry.initialize();

      disposeConfig = installCurrentPluginConfig(config);
      disposeRegistry = installCurrentServerRegistry(registry);
      activeSession = {
        config,
        registry,
        bootstrapper,
        ...(oauthBroker ? { oauthBroker } : {}),
        disposeConfig,
        disposeRegistry,
        disposeBootstrapper,
      };
    } catch (error) {
      activeSession = undefined;
      disposeRegistry?.();
      disposeConfig?.();
      oauthBroker?.launchAbortController.abort();
      await oauthBroker?.client.freeze().catch(() => undefined);
      await registry?.closeAll().catch(() => undefined);
      await oauthBroker?.client.close().catch(() => undefined);
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
          session.oauthBroker?.launchAbortController.abort();
          await session.oauthBroker?.client.freeze().catch(() => undefined);
          await session.registry.closeAll();
        } finally {
          await session.oauthBroker?.client.close().catch(() => undefined);
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
