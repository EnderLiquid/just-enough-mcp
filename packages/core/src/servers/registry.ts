import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import type { OverviewBootstrapperOptions } from "../overview/overview-bootstrapper.js";
import { OverviewBootstrapper } from "../overview/overview-bootstrapper.js";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";
import {
  RegistryClosedError,
  UnknownServerError,
  UnsupportedServerCapabilityError,
} from "./errors.js";
import {
  createMcpServer,
} from "./servers/factory.js";
import type { OauthHttpServerDependencies } from "./servers/oauth-http-server.js";
import { supportsOauthControls, type McpServer } from "./servers/types.js";

export {
  McpRegistryError,
  RegistryClosedError,
  UnknownServerError,
  UnsupportedServerCapabilityError,
} from "./errors.js";

export interface McpRegistryStatus {
  servers: ServerSnapshot[];
  connectedCount: number;
  totalCount: number;
}

export interface McpRegistryInitializationFailure {
  serverName: string;
  message: string;
}

export interface McpRegistryInitializationReport {
  eagerFailures: McpRegistryInitializationFailure[];
}

export type McpRegistryOverviewOptions = OverviewBootstrapperOptions;

export interface McpRegistryDependencies {
  readonly oauth?: OauthHttpServerDependencies;
  readonly overview?: McpRegistryOverviewOptions;
}

export interface McpRegistry {
  initialize(): Promise<McpRegistryInitializationReport>;
  getStatus(): Promise<McpRegistryStatus>;
  getServerSnapshot(name: string): Promise<ServerSnapshot>;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMcpRegistry(
  serverConfigs: readonly ResolvedServerConfig[],
  dependencies: McpRegistryDependencies = {},
): McpRegistry {
  const overviewBootstrapper = dependencies.overview
    ? new OverviewBootstrapper(dependencies.overview)
    : undefined;
  let servers: Map<string, McpServer>;

  try {
    servers = new Map(serverConfigs.map(config => [
      config.name,
      createMcpServer(config, {
        ...(dependencies.oauth ? { oauth: dependencies.oauth } : {}),
        ...(overviewBootstrapper ? { overviewBootstrapper } : {}),
      }),
    ]));
  } catch (error) {
    void overviewBootstrapper?.close().catch(() => undefined);
    throw error;
  }

  const lifecycleLock = new AsyncReadWriteLock();
  let initializationPromise: Promise<McpRegistryInitializationReport> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new RegistryClosedError();
    }
  }

  function requireServer(name: string): McpServer {
    assertOpen();
    const server = servers.get(name);
    if (!server) {
      throw new UnknownServerError(name);
    }
    return server;
  }

  return {
    initialize() {
      if (closed) {
        return Promise.reject(new RegistryClosedError());
      }
      initializationPromise ??= lifecycleLock.withWrite(async () => {
        assertOpen();
        const eagerFailures: McpRegistryInitializationFailure[] = [];

        for (const server of servers.values()) {
          if (server.config.connectionMode !== "eager") {
            continue;
          }

          try {
            await server.connect();
          } catch (error) {
            eagerFailures.push({
              serverName: server.name,
              message: getErrorMessage(error),
            });
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
        const server = requireServer(name);
        return await (server.status?.() ?? server.snapshot());
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
        throw new UnsupportedServerCapabilityError(name, "oauth-authorization");
      }
      return server.authorize(signal);
    },

    async logoutServer(name) {
      return lifecycleLock.withRead(async () => {
        const server = requireServer(name);
        if (!supportsOauthControls(server)) {
          throw new UnsupportedServerCapabilityError(name, "oauth-logout");
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
        await overviewBootstrapper?.close();
      });
      return closePromise;
    },
  };
}
