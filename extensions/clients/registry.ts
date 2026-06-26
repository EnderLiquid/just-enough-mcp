import type {
  PluginConfigLoadResult,
  RuntimeServerState,
  ServerCatalogResult,
  ToolCallExecutionResult,
} from "../modeling/types.js";
import { createServerDriver } from "./drivers/factory.js";
import { clearRuntimeSlotError, createRuntimeSlot, setRuntimeSlotStatus, setRuntimeSlotTools, updateRuntimeSlotConfig, type RuntimeSlot } from "./slot.js";

export interface ClientRegistryStatus {
  servers: RuntimeServerState[];
  connectedCount: number;
  totalCount: number;
}

export interface RegistryServerReadyEvent {
  server: RuntimeServerState;
  description?: string;
}

export interface ClientRegistryOptions {
  onServerReady?: (event: RegistryServerReadyEvent) => void | Promise<void>;
}

export interface ClientRegistry {
  syncConfig(config: PluginConfigLoadResult): Promise<void>;
  getStatus(): ClientRegistryStatus;
  getServerState(name: string): RuntimeServerState | undefined;
  connectServer(name: string): Promise<RuntimeServerState>;
  getServerCatalog(name: string): Promise<ServerCatalogResult>;
  callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult>;
  closeAll(): Promise<void>;
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClientRegistry(options: ClientRegistryOptions = {}): ClientRegistry {
  const slots = new Map<string, RuntimeSlot>();
  const inFlightConnections = new Map<string, Promise<RuntimeServerState>>();
  async function disconnectRemovedServers(nextNames: Set<string>): Promise<void> {
    const removedNames = [...slots.keys()].filter(name => !nextNames.has(name));
    for (const name of removedNames) {
      const slot = slots.get(name);
      if (slot?.driver) {
        await slot.driver.close().catch(() => {});
      }
      slots.delete(name);
    }
  }

  function upsertServerSlot(config: PluginConfigLoadResult["servers"][number]): void {
    const existing = slots.get(config.name);
    if (existing) {
      updateRuntimeSlotConfig(existing, config);
      return;
    }

    slots.set(config.name, createRuntimeSlot(config));
  }

  async function emitServerReady(slot: RuntimeSlot): Promise<void> {
    if (!slot.driver || !options.onServerReady) {
      return;
    }

    try {
      await options.onServerReady({
        server: slot.state,
        description: slot.driver.getServerDescription(),
      });
    } catch {
    }
  }

  async function ensureConnected(name: string): Promise<RuntimeServerState> {
    const slot = slots.get(name);
    if (!slot) {
      throw new Error(`Unknown MCP server: ${name}`);
    }

    if (slot.state.status === "connected" && slot.driver) {
      return slot.state;
    }

    const pending = inFlightConnections.get(name);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      setRuntimeSlotStatus(slot, "connecting");
      const nextDriver = createServerDriver(slot.state.config);
      try {
        await nextDriver.open();
        const tools = await nextDriver.listTools();
        const previous = slot.driver;
        if (previous) {
          await previous.close().catch(() => {});
        }
        slot.driver = nextDriver;
        setRuntimeSlotTools(slot, tools);
        const server = setRuntimeSlotStatus(slot, "connected");
        await emitServerReady(slot);
        return server;
      } catch (error) {
        await nextDriver.close().catch(() => {});
        return setRuntimeSlotStatus(slot, "error", serializeError(error));
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
        upsertServerSlot(server);
      }

      for (const server of config.servers) {
        if (server.connectionMode === "eager") {
          await ensureConnected(server.name);
        }
      }
    },

    getStatus() {
      const servers = [...slots.values()]
        .map(slot => slot.state)
        .sort((left, right) => left.config.name.localeCompare(right.config.name));
      return {
        servers,
        connectedCount: servers.filter(server => server.status === "connected").length,
        totalCount: servers.length,
      };
    },

    getServerState(name) {
      return slots.get(name)?.state;
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

      const slot = slots.get(name);
      if (!slot?.driver) {
        throw new Error(`No active connection for MCP server: ${name}`);
      }

      const result = await slot.driver.callTool(toolName, args);

      return {
        server,
        toolName,
        args,
        result,
      };
    },

    async closeAll() {
      const active = [...slots.values()]
        .map(slot => slot.driver)
        .filter(driver => driver !== undefined);
      for (const slot of slots.values()) {
        slot.driver = undefined;
      }
      await Promise.all(active.map(driver => driver.close().catch(() => {})));
      for (const slot of slots.values()) {
        setRuntimeSlotStatus(slot, "disconnected");
        clearRuntimeSlotError(slot);
      }
    },
  };
}
