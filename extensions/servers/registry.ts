import type {
  PluginConfigLoadResult,
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";
import { createMcpServer } from "./servers/factory.js";
import type { McpServer } from "./servers/types.js";

export interface ServerRegistryStatus {
  servers: ServerSnapshot[];
  connectedCount: number;
  totalCount: number;
}

export interface ServerRegistry {
  syncConfig(config: PluginConfigLoadResult): Promise<void>;
  getStatus(): Promise<ServerRegistryStatus>;
  getServerSnapshot(name: string): Promise<ServerSnapshot | undefined>;
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

function isConnectedSnapshot(snapshot: ServerSnapshot): boolean {
  return snapshot.connectState === "connected";
}

function areConfigsEqual(left: ResolvedServerConfig, right: ResolvedServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createServerRegistry(): ServerRegistry {
  const servers = new Map<string, McpServer>();
  const lifecycleLock = new AsyncReadWriteLock();

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
      await lifecycleLock.withWrite(async () => {
        const nextNames = new Set(config.servers.map(server => server.name));
        await removeMissingServers(nextNames);

        for (const serverConfig of config.servers) {
          await upsertServer(serverConfig);
        }

        for (const serverConfig of config.servers) {
          if (serverConfig.connectionMode === "eager") {
            const server = requireServer(serverConfig.name);
            await server.connect();
          }
        }
      });
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
        await Promise.all(active.map(server => server.close().catch(() => undefined)));
      });
    },
  };
}
