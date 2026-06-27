import type {
  PluginConfigLoadResult,
  ResolvedServerSpec,
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
  spec: ResolvedServerSpec;
  description?: string;
}

export interface ServerRegistryOptions {
  onServerReady?: (event: ServerReadyEvent) => void | Promise<void>;
}

export interface ServerRegistry {
  syncConfig(config: PluginConfigLoadResult): Promise<void>;
  getStatus(): ServerRegistryStatus;
  getServerState(name: string): ServerSnapshot | undefined;
  connectServer(name: string): Promise<ServerSnapshot>;
  getServerCatalog(name: string): Promise<ServerCatalogResult>;
  callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult>;
  closeAll(): Promise<void>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled server profile: ${value}`);
}

function isConnectedSnapshot(snapshot: ServerSnapshot): boolean {
  const profile = snapshot.profile;
  switch (profile) {
    case "stdio-tools-pragmatic":
      return snapshot.connectState === "connected";
    case "http-tools-public":
    case "http-tools-token":
      return snapshot.tools !== undefined;
    default:
      return assertNever(profile);
  }
}

function areSpecsEqual(left: ResolvedServerSpec, right: ResolvedServerSpec): boolean {
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
        spec: server.spec,
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

  async function upsertServer(spec: ResolvedServerSpec): Promise<void> {
    const existing = servers.get(spec.name);
    if (existing && areSpecsEqual(existing.spec, spec)) {
      return;
    }

    if (existing) {
      servers.delete(spec.name);
      await existing.close().catch(() => {});
    }

    servers.set(spec.name, createMcpServer(spec));
  }

  return {
    async syncConfig(config) {
      const nextNames = new Set(config.servers.map(server => server.name));
      await removeMissingServers(nextNames);

      for (const spec of config.servers) {
        await upsertServer(spec);
      }

      for (const spec of config.servers) {
        if (spec.connectionMode === "eager") {
          const server = requireServer(spec.name);
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

    async connectServer(name) {
      const server = requireServer(name);
      const snapshot = await server.connect();
      await emitServerReady(server);
      return snapshot;
    },

    async getServerCatalog(name) {
      return requireServer(name).getCatalog();
    },

    async callTool(name, toolName, args) {
      return requireServer(name).callTool(toolName, args);
    },

    async closeAll() {
      const active = [...servers.values()];
      servers.clear();
      await Promise.all(active.map(server => server.close().catch(() => {})));
    },
  };
}
