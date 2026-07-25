import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerConfig, ServerConnectState } from "../../modeling/types.js";
import { applyToolNameFilter, createToolNameFilter, isToolNameFilteredByConfig, type ToolNameFilter } from "./tool-filter.js";

interface SdkToolSessionOptions {
  serverName: string;
  config: ResolvedServerConfig;
  createTransport: () => Transport;
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
  private connectState: ServerConnectState = "disconnected";
  private connectPromise: Promise<void> | undefined;
  private readonly toolFilter: ToolNameFilter;

  constructor(private readonly options: SdkToolSessionOptions) {
    this.toolFilter = createToolNameFilter(options.config);
  }

  get state(): ServerConnectState {
    return this.connectState;
  }

  get tools(): Tool[] | undefined {
    return this.visibleTools();
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.client) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectPromise = this.connectFresh(signal);
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    }
  }

  async getTools(signal?: AbortSignal): Promise<Tool[]> {
    await this.connect(signal);
    return this.visibleTools() ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    await this.connect(signal);
    this.requireAvailableTool(name);
    const client = this.requireClient();

    try {
      return await client.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      ) as CallToolResult;
    } catch (error) {
      if (isConnectionFailure(error, client) && this.client === client) {
        await this.close();
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;

    this.client = undefined;
    this.transport = undefined;
    this.remoteTools = undefined;
    this.connectState = "disconnected";

    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  getServerDescription(): string | undefined {
    return this.client?.getServerVersion()?.description;
  }

  private async connectFresh(signal?: AbortSignal): Promise<void> {
    this.connectState = "connecting";
    const client = createBaseClient(this.options.serverName);
    const transport = this.options.createTransport();
    const requestOptions = signal ? { signal } : undefined;

    try {
      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, requestOptions);

      this.client = client;
      this.transport = transport;
      this.remoteTools = listed.tools ?? [];
      this.connectState = "connected";
    } catch (error) {
      this.connectState = "disconnected";
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private visibleTools(): Tool[] | undefined {
    if (!this.remoteTools) {
      return undefined;
    }
    return applyToolNameFilter(this.remoteTools, this.toolFilter);
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error(`MCP server client is not open: ${this.options.serverName}`);
    }
    return this.client;
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
