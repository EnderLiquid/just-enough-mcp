import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getArtifactsDirectoryPath,
  getOAuthBrokerDirectoryPath,
  getOverviewDirectoryPath,
  getPluginConfigPath,
  getProjectPluginConfigPath,
} from "./config/paths.js";
import { pluralize } from "./formatting/english.js";
import { loadPluginConfigFromPaths } from "./config/plugin-config.js";
import type { PluginConfigLoadResult } from "./modeling/types.js";
import { createServerOverviewPrompt } from "./prompting/system-prompt.js";
import { createFooterStatusController, type FooterStatusController } from "./rendering/footer-status.js";
import { createNotifier } from "./rendering/notifier.js";
import { OverviewBootstrapper } from "./config/overview-bootstrapper.js";
import { OAuthBrokerClient } from "./oauth/broker/client.js";
import {
  createOAuthBrokerBootstrapper,
  type OAuthBrokerBootstrapper,
} from "./oauth/broker/bootstrapper.js";
import { createOAuthBrokerNamespace } from "./oauth/broker/namespace.js";
import { DEFAULT_OAUTH_BROKER_PORT } from "./oauth/broker/protocol.js";
import { createServerRegistry, type ServerRegistry } from "./servers/registry.js";
import {
  registerMcpServerTool,
  type McpServerToolRuntime,
} from "./tools/mcp-server-tool.js";
import {
  registerMcpTool,
  type McpToolRuntime,
} from "./tools/mcp-tool.js";

interface ActivePluginSession {
  config: PluginConfigLoadResult;
  registry: ServerRegistry;
  overviewBootstrapper: OverviewBootstrapper;
  oauthBroker?: {
    client: OAuthBrokerClient;
    launcher: OAuthBrokerBootstrapper;
    launchAbortController: AbortController;
    namespaceId: string;
  };
  footerStatus: FooterStatusController;
}

const MCP_SERVERS_SECTION_HEADING = "# MCP Servers";

function hasMcpServersSection(systemPrompt: string): boolean {
  return systemPrompt
    .split(/\r?\n/)
    .some(line => line.trim() === MCP_SERVERS_SECTION_HEADING);
}

function loadSessionPluginConfig(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): PluginConfigLoadResult {
  const configPaths = [getPluginConfigPath()];
  if (ctx.isProjectTrusted()) {
    configPaths.push(getProjectPluginConfigPath(ctx.cwd));
  }

  return loadPluginConfigFromPaths(
    configPaths,
    getOverviewDirectoryPath(),
    getArtifactsDirectoryPath(),
  );
}

export default function justEnoughMcp(pi: ExtensionAPI): void {
  let activeSession: ActivePluginSession | undefined;

  const serverToolRuntime: McpServerToolRuntime = {
    getRegistry: () => activeSession?.registry,
    getTuiSettings: () => activeSession?.config.tui,
    refreshFooterStatus: status => activeSession?.footerStatus.refresh(status),
  };
  const toolRuntime: McpToolRuntime = {
    getRegistry: () => activeSession?.registry,
    getArtifactDir: () => activeSession?.config.artifactDir ?? getArtifactsDirectoryPath(),
    getMaterializationSettings: () => activeSession?.config.materialization,
    getTuiSettings: () => activeSession?.config.tui,
    refreshFooterStatus: status => activeSession?.footerStatus.refresh(status),
  };

  registerMcpServerTool(pi, serverToolRuntime);
  registerMcpTool(pi, toolRuntime);

  pi.on("session_start", async (_event, ctx) => {
    const notifier = createNotifier(
      ctx.hasUI ? { notify: ctx.ui.notify.bind(ctx.ui) } : undefined,
    );
    const footerStatus = createFooterStatusController(ctx.hasUI ? ctx.ui : undefined);

    let config: PluginConfigLoadResult | undefined;
    let registry: ServerRegistry | undefined;
    let overviewBootstrapper: OverviewBootstrapper | undefined;
    let oauthBroker: ActivePluginSession["oauthBroker"];

    try {
      config = loadSessionPluginConfig(ctx);
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
          onWarning: (message, error) => notifier.notifyWarning(
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
            notifier.notifyWarning(`OAuth broker could not be bootstrapped: ${message}`);
          }
        });
      }

      overviewBootstrapper = new OverviewBootstrapper({
        overviewDir: config.overviewDir,
        onCreated: serverName => notifier.notifyInfo(`Created MCP overview stub: ${serverName}`),
      });

      registry = createServerRegistry(config.servers, {
        overviewBootstrapper,
        ...(oauthBroker
          ? {
              oauth: {
                brokerClient: oauthBroker.client,
                namespaceId: oauthBroker.namespaceId,
              },
            }
          : {}),
      });
      const initialization = await registry.initialize();
      if (initialization.eagerFailures.length > 0) {
        notifier.notifyWarning(
          `${initialization.eagerFailures.length} ${pluralize(initialization.eagerFailures.length, "eager MCP server")} could not be initialized: ` +
          `${initialization.eagerFailures.join(", ")}. Use mcp_server or mcp_tool to retry on demand.`,
        );
      }

      activeSession = {
        config,
        registry,
        overviewBootstrapper,
        ...(oauthBroker ? { oauthBroker } : {}),
        footerStatus,
      };
    } catch (error) {
      activeSession = undefined;
      oauthBroker?.launchAbortController.abort();
      await oauthBroker?.client.close().catch(() => undefined);
      await registry?.close().catch(() => undefined);
      await overviewBootstrapper?.close().catch(() => undefined);
      footerStatus.dispose();

      const message = error instanceof Error ? error.message : String(error);
      notifier.notifyError(`just-enough-mcp config error: ${message}`);
      footerStatus.refresh();
      return;
    }

    try {
      await footerStatus.refresh(await registry.getStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifier.notifyError(`just-enough-mcp config error: ${message}`);
      footerStatus.refresh();
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (hasMcpServersSection(event.systemPrompt)) {
      return;
    }

    const config = activeSession?.config;

    if (!config) {
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n${MCP_SERVERS_SECTION_HEADING}\n\n` +
          "just-enough-mcp has not loaded its configuration for this session yet. Use /reload if needed.",
      };
    }

    const injectedPrompt = createServerOverviewPrompt(config);
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n${MCP_SERVERS_SECTION_HEADING}\n\n${injectedPrompt}`,
    };
  });

  pi.on("session_shutdown", async () => {
    const session = activeSession;
    activeSession = undefined;

    if (!session) {
      return;
    }

    try {
      session.oauthBroker?.launchAbortController.abort();
      await session.oauthBroker?.client.close().catch(() => undefined);
      await session.registry.close();
    } finally {
      await session.overviewBootstrapper.close();
      session.footerStatus.dispose();
    }
  });
}
