import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerConfig, ServerConnectState } from "../../modeling/types.js";
import type { OverviewBootstrapper } from "../../config/overview-bootstrapper.js";
import { AsyncReadWriteLock } from "../../concurrency/async-read-write-lock.js";
import { applyToolNameFilter, createToolNameFilter, isToolNameFilteredByConfig, type ToolNameFilter } from "./tool-filter.js";

interface SdkSessionOptions {
  serverName: string;
  config: ResolvedServerConfig;
  overviewBootstrapper?: OverviewBootstrapper;
  createTransport: () => Transport;
}

export interface SdkSessionSnapshot {
  connectState: ServerConnectState;
  tools?: Tool[];
  description?: string;
}

export interface SdkSessionToolCatalogResult {
  snapshot: SdkSessionSnapshot;
  tools: Tool[];
}

export interface SdkSessionToolCallResult {
  snapshot: SdkSessionSnapshot;
  result: CallToolResult;
}

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

export class SdkSessionManager {
  private client: Client | undefined;
  private remoteTools: Tool[] | undefined;
  private publishedState: SdkSessionSnapshot = { connectState: "disconnected" };
  private readonly lifecycleLock = new AsyncReadWriteLock();
  private readonly toolFilter: ToolNameFilter;

  constructor(private readonly options: SdkSessionOptions) {
    this.toolFilter = createToolNameFilter(options.config);
  }

  async connect(signal?: AbortSignal): Promise<SdkSessionSnapshot> {
    const connectedSnapshot = await this.lifecycleLock.withRead(() =>
      this.client ? this.snapshot() : undefined,
    );
    if (connectedSnapshot) {
      return connectedSnapshot;
    }

    return this.lifecycleLock.withWrite(async () => {
      await this.connectLocked(signal);
      return this.snapshot();
    });
  }

  async getTools(signal?: AbortSignal): Promise<SdkSessionToolCatalogResult> {
    return this.withConnectedRead(signal, () => {
      const tools = this.visibleTools() ?? [];
      return {
        snapshot: this.snapshot(),
        tools,
      };
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SdkSessionToolCallResult> {
    return this.withConnectedRead(signal, async () => {
      this.requireAvailableTool(name);
      const result = await this.client!.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      ) as CallToolResult;
      return {
        snapshot: this.snapshot(),
        result,
      };
    });
  }

  async close(): Promise<SdkSessionSnapshot> {
    return this.lifecycleLock.withWrite(() => this.closeLocked());
  }

  snapshot(): SdkSessionSnapshot {
    return {
      ...this.publishedState,
      tools: this.publishedState.tools ? [...this.publishedState.tools] : undefined,
    };
  }

  private async withConnectedRead<T>(
    signal: AbortSignal | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const initial = await this.lifecycleLock.withRead(async () => {
      if (!this.client) {
        return { connected: false } as const;
      }

      return {
        connected: true,
        value: await operation(),
      } as const;
    });

    if (initial.connected) {
      return initial.value;
    }

    await this.lifecycleLock.withWrite(() => this.connectLocked(signal));

    return this.lifecycleLock.withRead(async () => {
      if (!this.client) {
        throw new Error(
          `MCP server "${this.options.serverName}" became unavailable before the requested operation could start.`,
        );
      }

      return operation();
    });
  }

  private async connectLocked(signal?: AbortSignal): Promise<void> {
    if (this.client) {
      return;
    }

    this.publishState("connecting");

    let client: Client | undefined;
    let closedBeforePublish = false;
    try {
      client = createBaseClient(this.options.serverName);
      const candidate = client;
      client.onclose = () => {
        closedBeforePublish = true;
        this.enqueueClientInvalidation(candidate);
      };
      const transport = this.options.createTransport();
      const requestOptions = signal ? { signal } : undefined;

      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, requestOptions);
      if (closedBeforePublish) {
        throw new Error(`MCP client for server "${this.options.serverName}" closed during initialization.`);
      }

      this.client = client;
      this.remoteTools = listed.tools ?? [];
      const description = client.getServerVersion()?.description;
      this.publishedState = {
        connectState: "connected",
        tools: this.visibleTools() ?? [],
        ...(description ? { description } : {}),
      };
      if (typeof description === "string" && description.trim().length > 0) {
        try {
          this.options.overviewBootstrapper?.notify({
            config: this.options.config,
            description,
          });
        } catch {
        }
      }
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
      }
      this.remoteTools = undefined;
      this.publishState("disconnected");
      await client?.close().catch(() => {});
      throw error;
    }
  }

  private async closeLocked(): Promise<SdkSessionSnapshot> {
    const client = this.client;
    if (!client) {
      this.remoteTools = undefined;
      this.publishState("disconnected");
      return this.snapshot();
    }

    this.client = undefined;
    this.remoteTools = undefined;
    this.publishState("disconnecting");

    await client.close().catch(() => {});
    this.publishState("disconnected");
    return this.snapshot();
  }

  private enqueueClientInvalidation(client: Client): void {
    void this.lifecycleLock
      .withWrite(() => this.invalidateClientLocked(client))
      .catch(() => {});
  }

  private invalidateClientLocked(client: Client): void {
    if (this.client !== client) {
      return;
    }

    this.client = undefined;
    this.remoteTools = undefined;
    this.publishState("disconnected");
  }

  private publishState(connectState: ServerConnectState): void {
    this.publishedState = {
      connectState,
      ...(this.publishedState.description ? { description: this.publishedState.description } : {}),
    };
  }

  private visibleTools(): Tool[] | undefined {
    if (!this.remoteTools) {
      return undefined;
    }
    return applyToolNameFilter(this.remoteTools, this.toolFilter);
  }

  private requireAvailableTool(toolName: string): void {
    if (this.visibleTools()?.some(tool => tool.name === toolName)) {
      return;
    }

    if (this.remoteTools?.some(tool => tool.name === toolName) && isToolNameFilteredByConfig(toolName, this.toolFilter)) {
      throw new Error(`Tool "${toolName}" is excluded by configuration on MCP server "${this.options.serverName}".`);
    }

    throw new Error(`Tool "${toolName}" is not available on MCP server "${this.options.serverName}".`);
  }
}
