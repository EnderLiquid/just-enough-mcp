import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";
import {
  createMcpServer,
  type McpServerFactoryDependencies,
} from "./servers/factory.js";
import { supportsOauthControls, type McpServer } from "./servers/types.js";

export interface ServerRegistryStatus {
  servers: ServerSnapshot[];
  connectedCount: number;
  totalCount: number;
}

export interface ServerRegistryInitializationReport {
  eagerFailures: string[];
}

export interface ServerRegistry {
  initialize(): Promise<ServerRegistryInitializationReport>;
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
  close(): Promise<void>;
}

function isConnectedSnapshot(snapshot: ServerSnapshot): boolean {
  return snapshot.connectState === "connected";
}

export function createServerRegistry(
  serverConfigs: readonly ResolvedServerConfig[],
  dependencies: McpServerFactoryDependencies = {},
): ServerRegistry {
  const servers = new Map(serverConfigs.map(config => [
    config.name,
    createMcpServer(config, dependencies),
  ]));
  const lifecycleLock = new AsyncReadWriteLock();
  let initializationPromise: Promise<ServerRegistryInitializationReport> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new Error("MCP server registry is closed.");
    }
  }

  function requireServer(name: string): McpServer {
    assertOpen();
    const server = servers.get(name);
    if (!server) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    return server;
  }

  return {
    initialize() {
      assertOpen();
      initializationPromise ??= lifecycleLock.withWrite(async () => {
        assertOpen();
        const eagerFailures: string[] = [];

        for (const server of servers.values()) {
          if (server.config.connectionMode !== "eager") {
            continue;
          }

          try {
            await server.connect();
          } catch {
            eagerFailures.push(server.name);
          }
        }

        return { eagerFailures };
      });
      return initializationPromise;
    },

    async getStatus() {
      return lifecycleLock.withRead(async () => {
        assertOpen();
        const snapshots = await Promise.all(
          [...servers.values()].map(server => server.status?.() ?? server.snapshot()),
        );
        snapshots.sort((left, right) => left.name.localeCompare(right.name));
        return {
          servers: snapshots,
          connectedCount: snapshots.filter(isConnectedSnapshot).length,
          totalCount: snapshots.length,
        };
      });
    },

    async getServerSnapshot(name) {
      return lifecycleLock.withRead(async () => {
        assertOpen();
        const server = servers.get(name);
        return server ? await (server.status?.() ?? server.snapshot()) : undefined;
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

    close() {
      closePromise ??= lifecycleLock.withWrite(async () => {
        if (closed) {
          return;
        }
        closed = true;
        const active = [...servers.values()];
        servers.clear();
        await Promise.all(active.map(server => server.close().catch(() => undefined)));
      });
      return closePromise;
    },
  };
}
