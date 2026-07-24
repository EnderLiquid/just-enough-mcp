import type {
  PluginConfigLoadResult,
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import { createMcpServer } from "./servers/factory.js";
import type { McpServer } from "./servers/types.js";

export interface ServerRegistryStatus {
  servers: ServerSnapshot[];
  connectedCount: number;
  totalCount: number;
}

export interface ServerReadyEvent {
  config: ResolvedServerConfig;
  description?: string;
}

export interface ServerRegistryOptions {
  onServerReady?: (event: ServerReadyEvent) => void | Promise<void>;
}

export interface ServerRegistry {
  syncConfig(config: PluginConfigLoadResult): Promise<void>;
  getStatus(): ServerRegistryStatus;
  getServerState(name: string): ServerSnapshot | undefined;
  connectServer(name: string, signal?: AbortSignal): Promise<ServerSnapshot>;
  disconnectServer(name: string): Promise<ServerSnapshot>;
  getServerCatalog(name: string, signal?: AbortSignal): Promise<ServerCatalogResult>;
  callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult>;
  closeAll(): Promise<void>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled server profile: ${value}`);
}

function isConnectedSnapshot(snapshot: ServerSnapshot): boolean {
  const profile = snapshot.profile;
  switch (profile) {
    case "stdio-tools-pragmatic":
    case "http-tools-public":
    case "http-tools-token":
      return snapshot.connectState === "connected";
    default:
      return assertNever(profile);
  }
}

function areConfigsEqual(left: ResolvedServerConfig, right: ResolvedServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createServerRegistry(options: ServerRegistryOptions = {}): ServerRegistry {
  const servers = new Map<string, McpServer>();

  async function emitServerReady(server: McpServer): Promise<void> {
    if (!options.onServerReady) {
      return;
    }

    try {
      await options.onServerReady({
        config: server.config,
        description: server.getServerDescription(),
      });
    } catch {
    }
  }

  function requireServer(name: string): McpServer {
    const server = servers.get(name);
    if (!server) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    return server;
  }

  async function removeMissingServers(nextNames: Set<string>): Promise<void> {
    const removedNames = [...servers.keys()].filter(name => !nextNames.has(name));
    for (const name of removedNames) {
      const server = servers.get(name);
      servers.delete(name);
      await server?.close().catch(() => {});
    }
  }

  async function upsertServer(config: ResolvedServerConfig): Promise<void> {
    const existing = servers.get(config.name);
    if (existing && areConfigsEqual(existing.config, config)) {
      return;
    }

    if (existing) {
      servers.delete(config.name);
      await existing.close().catch(() => {});
    }

    servers.set(config.name, createMcpServer(config));
  }

  return {
    async syncConfig(config) {
      const nextNames = new Set(config.servers.map(server => server.name));
      await removeMissingServers(nextNames);

      for (const serverConfig of config.servers) {
        await upsertServer(serverConfig);
      }

      for (const serverConfig of config.servers) {
        if (serverConfig.connectionMode === "eager") {
          const server = requireServer(serverConfig.name);
          await server.connect();
          await emitServerReady(server);
        }
      }
    },

    getStatus() {
      const snapshots = [...servers.values()]
        .map(server => server.snapshot())
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        servers: snapshots,
        connectedCount: snapshots.filter(isConnectedSnapshot).length,
        totalCount: snapshots.length,
      };
    },

    getServerState(name) {
      return servers.get(name)?.snapshot();
    },

    async connectServer(name, signal) {
      const server = requireServer(name);
      const snapshot = await server.connect(signal);
      await emitServerReady(server);
      return snapshot;
    },

    async disconnectServer(name) {
      const server = requireServer(name);
      if (server.snapshot().connectState === "connecting") {
        throw new Error(
          `Cannot disconnect MCP server "${name}" while it is connecting. Cancel the in-flight operation first.`,
        );
      }
      await server.close();
      return server.snapshot();
    },

    async getServerCatalog(name, signal) {
      return requireServer(name).getCatalog(signal);
    },

    async callTool(name, toolName, args, signal) {
      return requireServer(name).callTool(toolName, args, signal);
    },

    async closeAll() {
      const active = [...servers.values()];
      servers.clear();
      await Promise.all(active.map(server => server.close().catch(() => {})));
    },
  };
}
