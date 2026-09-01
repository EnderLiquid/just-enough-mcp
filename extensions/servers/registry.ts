import { getOauthCredentialsFilePath } from "../config/paths.js";
import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import { createOauthSessionServices } from "../oauth/session-services.js";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";
import { pluralize } from "../formatting/english.js";
import { notifyWarning } from "../rendering/notifier.js";
import { createMcpServer } from "./servers/factory.js";
import { supportsOauthControls, type McpServer } from "./servers/types.js";

export interface ServerRegistryStatus {
  servers: ServerSnapshot[];
  connectedCount: number;
  totalCount: number;
}

export interface ServerRegistry {
  initialize(): Promise<void>;
  getStatus(): Promise<ServerRegistryStatus>;
  getServerSnapshot(name: string): Promise<ServerSnapshot | undefined>;
  connectServer(name: string, signal?: AbortSignal): Promise<ServerSnapshot>;
  disconnectServer(name: string): Promise<ServerSnapshot>;
  authorizeServer(name: string, signal?: AbortSignal): Promise<ServerSnapshot>;
  logoutServer(name: string): Promise<ServerSnapshot>;
  getServerCatalog(name: string, signal?: AbortSignal): Promise<ServerCatalogResult>;
  callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult>;
  closeAll(): Promise<void>;
}

function isConnectedSnapshot(snapshot: ServerSnapshot): boolean {
  return snapshot.connectState === "connected";
}

export function createServerRegistry(
  serverConfigs: readonly ResolvedServerConfig[],
): ServerRegistry {
  const oauthServices = createOauthSessionServices({
    credentialFilePath: getOauthCredentialsFilePath(),
  });
  let servers: Map<string, McpServer>;
  try {
    servers = new Map(serverConfigs.map(config => [
      config.name,
      createMcpServer(config, oauthServices),
    ]));
  } catch (error) {
    void oauthServices.close().catch(() => undefined);
    throw error;
  }
  const lifecycleLock = new AsyncReadWriteLock();
  let initializationPromise: Promise<void> | undefined;

  function requireServer(name: string): McpServer {
    const server = servers.get(name);
    if (!server) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    return server;
  }

  return {
    initialize() {
      initializationPromise ??= lifecycleLock.withWrite(async () => {
        const failedServerNames: string[] = [];

        for (const server of servers.values()) {
          if (server.config.connectionMode !== "eager") {
            continue;
          }

          try {
            await server.connect();
          } catch {
            failedServerNames.push(server.name);
          }
        }

        if (failedServerNames.length > 0) {
          notifyWarning(
            `${failedServerNames.length} ${pluralize(failedServerNames.length, "eager MCP server")} could not be initialized: ` +
            `${failedServerNames.join(", ")}. Use mcp_server or mcp_tool to retry on demand.`,
          );
        }
      });
      return initializationPromise;
    },

    async getStatus() {
      return lifecycleLock.withRead(() => {
        const snapshots = [...servers.values()]
            .map(server => server.snapshot())
            .sort((left, right) => left.name.localeCompare(right.name));
        return {
          servers: snapshots,
          connectedCount: snapshots.filter(isConnectedSnapshot).length,
          totalCount: snapshots.length,
        };
      });
    },

    async getServerSnapshot(name) {
      return lifecycleLock.withRead(() => {
        return servers.get(name)?.snapshot();
      });
    },

    async connectServer(name, signal) {
      return lifecycleLock.withRead(async () => {
        const server = requireServer(name);
        return server.connect(signal);
      });
    },

    async disconnectServer(name) {
      return lifecycleLock.withRead(async () => {
        const server = requireServer(name);
        return server.close();
      });
    },

    async authorizeServer(name, signal) {
      const server = await lifecycleLock.withRead(() => requireServer(name));
      if (!supportsOauthControls(server)) {
        throw new Error(`MCP server "${name}" does not support OAuth authorization.`);
      }
      return server.authorize(signal);
    },

    async logoutServer(name) {
      return lifecycleLock.withRead(async () => {
        const server = requireServer(name);
        if (!supportsOauthControls(server)) {
          throw new Error(`MCP server "${name}" does not support OAuth logout.`);
        }
        return server.logout();
      });
    },

    async getServerCatalog(name, signal) {
      return lifecycleLock.withRead(() => {
        return requireServer(name).getCatalog(signal);
      });
    },

    async callTool(name, toolName, args, signal) {
      return lifecycleLock.withRead(() => {
        return requireServer(name).callTool(toolName, args, signal);
      });
    },

    async closeAll() {
      await lifecycleLock.withWrite(async () => {
        const active = [...servers.values()];
        servers.clear();
        try {
          await Promise.all(active.map(server => server.close().catch(() => undefined)));
        } finally {
          await oauthServices.close();
        }
      });
    },
  };
}
