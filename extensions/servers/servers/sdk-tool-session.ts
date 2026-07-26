import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerConfig, ServerConnectState } from "../../modeling/types.js";
import { AsyncReadWriteLock } from "../async-read-write-lock.js";
import { applyToolNameFilter, createToolNameFilter, isToolNameFilteredByConfig, type ToolNameFilter } from "./tool-filter.js";

interface SdkToolSessionOptions {
  serverName: string;
  config: ResolvedServerConfig;
  createTransport: () => Transport;
}

export interface SdkToolSessionSnapshot {
  connectState: ServerConnectState;
  tools?: Tool[];
}

export interface SdkToolSessionCatalogResult {
  snapshot: SdkToolSessionSnapshot;
  tools: Tool[];
}

export interface SdkToolSessionCallResult {
  snapshot: SdkToolSessionSnapshot;
  result: CallToolResult;
}

interface PublishedSessionState extends SdkToolSessionSnapshot {
  description?: string;
}

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

function isConnectionFailure(error: unknown, client: Client): boolean {
  return (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
    || client.transport === undefined;
}

export class SdkToolSession {
  private client: Client | undefined;
  private transport: Transport | undefined;
  private remoteTools: Tool[] | undefined;
  private publishedState: PublishedSessionState = { connectState: "disconnected" };
  private readonly lifecycleLock = new AsyncReadWriteLock();
  private readonly toolFilter: ToolNameFilter;

  constructor(private readonly options: SdkToolSessionOptions) {
    this.toolFilter = createToolNameFilter(options.config);
  }

  get state(): ServerConnectState {
    return this.publishedState.connectState;
  }

  get tools(): Tool[] | undefined {
    return this.publishedState.tools ? [...this.publishedState.tools] : undefined;
  }

  async connect(signal?: AbortSignal): Promise<SdkToolSessionSnapshot> {
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

  async getTools(signal?: AbortSignal): Promise<SdkToolSessionCatalogResult> {
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
  ): Promise<SdkToolSessionCallResult> {
    let failedClient: Client | undefined;

    try {
      return await this.withConnectedRead(signal, async client => {
        this.requireAvailableTool(name);

        try {
          const result = await client.callTool(
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
        } catch (error) {
          if (isConnectionFailure(error, client)) {
            failedClient = client;
          }
          throw error;
        }
      });
    } catch (error) {
      const clientToInvalidate = failedClient;
      if (clientToInvalidate) {
        await this.lifecycleLock.withWrite(async () => {
          if (this.client === clientToInvalidate) {
            await this.closeLocked();
          }
        });
      }
      throw error;
    }
  }

  async close(): Promise<SdkToolSessionSnapshot> {
    return this.lifecycleLock.withWrite(() => this.closeLocked());
  }

  getServerDescription(): string | undefined {
    return this.publishedState.description;
  }

  private snapshot(): SdkToolSessionSnapshot {
    return {
      connectState: this.publishedState.connectState,
      tools: this.tools,
    };
  }

  private async withConnectedRead<T>(
    signal: AbortSignal | undefined,
    operation: (client: Client) => T | Promise<T>,
  ): Promise<T> {
    while (true) {
      const outcome = await this.lifecycleLock.withRead(async () => {
        const client = this.client;
        if (!client) {
          return { connected: false } as const;
        }

        return {
          connected: true,
          value: await operation(client),
        } as const;
      });

      if (outcome.connected) {
        return outcome.value;
      }

      await this.lifecycleLock.withWrite(() => this.connectLocked(signal));
    }
  }

  private async connectLocked(signal?: AbortSignal): Promise<void> {
    if (this.client) {
      return;
    }

    this.publishedState = {
      connectState: "connecting",
      ...(this.publishedState.description ? { description: this.publishedState.description } : {}),
    };

    let client: Client | undefined;
    let transport: Transport | undefined;
    try {
      client = createBaseClient(this.options.serverName);
      transport = this.options.createTransport();
      const requestOptions = signal ? { signal } : undefined;

      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, requestOptions);

      this.client = client;
      this.transport = transport;
      this.remoteTools = listed.tools ?? [];
      const description = client.getServerVersion()?.description;
      this.publishedState = {
        connectState: "connected",
        tools: this.visibleTools() ?? [],
        ...(description ? { description } : {}),
      };
    } catch (error) {
      this.client = undefined;
      this.transport = undefined;
      this.remoteTools = undefined;
      this.publishedState = {
        connectState: "disconnected",
        ...(this.publishedState.description ? { description: this.publishedState.description } : {}),
      };
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      throw error;
    }
  }

  private async closeLocked(): Promise<SdkToolSessionSnapshot> {
    const client = this.client;
    const transport = this.transport;

    this.client = undefined;
    this.transport = undefined;
    this.remoteTools = undefined;
    this.publishedState = {
      connectState: "disconnected",
      ...(this.publishedState.description ? { description: this.publishedState.description } : {}),
    };

    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    return this.snapshot();
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
