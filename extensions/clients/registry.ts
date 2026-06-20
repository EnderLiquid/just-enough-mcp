import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  PluginConfigLoadResult,
  ResolvedServerConfig,
  RuntimeServerState,
  RuntimeServerStatus,
  ServerCatalogResult,
  ToolCallExecutionResult,
} from "../modeling/types.js";

interface RuntimeConnection {
  client: Client;
  close: () => Promise<void>;
}

export interface ClientRegistrySnapshot {
  servers: RuntimeServerState[];
  connectedCount: number;
  totalCount: number;
}

export interface ClientRegistry {
  syncConfig(config: PluginConfigLoadResult): Promise<void>;
  getSnapshot(): ClientRegistrySnapshot;
  getServerState(name: string): RuntimeServerState | undefined;
  connectServer(name: string): Promise<RuntimeServerState>;
  getServerCatalog(name: string): Promise<ServerCatalogResult>;
  callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult>;
  closeAll(): Promise<void>;
}

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

function setStatus(target: RuntimeServerState, status: RuntimeServerStatus, error?: string): RuntimeServerState {
  target.status = status;
  target.error = error;
  return target;
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function connectClient(config: ResolvedServerConfig): Promise<{ connection: RuntimeConnection; tools: Tool[] }> {
  const client = createBaseClient(config.name);

  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "ignore",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    return {
      connection: {
        client,
        close: async () => {
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
        },
      },
      tools: listed.tools ?? [],
    };
  }

  const headers = { ...(config.headers ?? {}) };
  if (config.bearerToken) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    connection: {
      client,
      close: async () => {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    },
    tools: listed.tools ?? [],
  };
}

export function createClientRegistry(): ClientRegistry {
  const serverStates = new Map<string, RuntimeServerState>();
  const connections = new Map<string, RuntimeConnection>();
  const inFlightConnections = new Map<string, Promise<RuntimeServerState>>();

  async function disconnectRemovedServers(nextNames: Set<string>): Promise<void> {
    const removedNames = [...serverStates.keys()].filter(name => !nextNames.has(name));
    for (const name of removedNames) {
      const existing = connections.get(name);
      if (existing) {
        await existing.close().catch(() => {});
        connections.delete(name);
      }
      serverStates.delete(name);
    }
  }

  function upsertServerState(config: ResolvedServerConfig): void {
    const existing = serverStates.get(config.name);
    if (existing) {
      existing.config = config;
      return;
    }

    serverStates.set(config.name, {
      config,
      status: "disconnected",
    });
  }

  async function ensureConnected(name: string): Promise<RuntimeServerState> {
    const existingState = serverStates.get(name);
    if (!existingState) {
      throw new Error(`Unknown MCP server: ${name}`);
    }

    if (existingState.status === "connected" && connections.has(name)) {
      return existingState;
    }

    const pending = inFlightConnections.get(name);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      setStatus(existingState, "connecting");
      try {
        const connected = await connectClient(existingState.config);
        const previous = connections.get(name);
        if (previous) {
          await previous.close().catch(() => {});
        }
        connections.set(name, connected.connection);
        existingState.tools = connected.tools;
        return setStatus(existingState, "connected");
      } catch (error) {
        return setStatus(existingState, "error", serializeError(error));
      } finally {
        inFlightConnections.delete(name);
      }
    })();

    inFlightConnections.set(name, promise);
    return promise;
  }

  return {
    async syncConfig(config) {
      const nextNames = new Set(config.servers.map(server => server.name));
      await disconnectRemovedServers(nextNames);

      for (const server of config.servers) {
        upsertServerState(server);
      }

      for (const server of config.servers) {
        if (server.connectionMode === "eager") {
          await ensureConnected(server.name);
        }
      }
    },

    getSnapshot() {
      const servers = [...serverStates.values()].sort((left, right) => left.config.name.localeCompare(right.config.name));
      return {
        servers,
        connectedCount: servers.filter(server => server.status === "connected").length,
        totalCount: servers.length,
      };
    },

    getServerState(name) {
      return serverStates.get(name);
    },

    async connectServer(name) {
      return ensureConnected(name);
    },

    async getServerCatalog(name) {
      const server = await ensureConnected(name);
      if (server.status !== "connected") {
        throw new Error(server.error ?? `Failed to connect to MCP server: ${name}`);
      }
      return {
        server,
        tools: server.tools ?? [],
      };
    },

    async callTool(name, toolName, args) {
      const server = await ensureConnected(name);
      if (server.status !== "connected") {
        throw new Error(server.error ?? `Failed to connect to MCP server: ${name}`);
      }

      const connection = connections.get(name);
      if (!connection) {
        throw new Error(`No active connection for MCP server: ${name}`);
      }

      const result = (await connection.client.callTool({
        name: toolName,
        arguments: args,
      })) as CallToolResult;

      return {
        server,
        toolName,
        args,
        result,
      };
    },

    async closeAll() {
      const active = [...connections.values()];
      connections.clear();
      await Promise.all(active.map(connection => connection.close().catch(() => {})));
      for (const server of serverStates.values()) {
        setStatus(server, "disconnected");
        server.error = undefined;
      }
    },
  };
}
