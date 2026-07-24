import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CompatibilityProfile, ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import { applyToolNameFilter, createToolNameFilter, isToolNameFilteredByConfig, type ToolNameFilter } from "./tool-filter.js";
import type { McpServer } from "./types.js";

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

function isConnectionFailure(error: unknown, client: Client): boolean {
  return (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
    || client.transport === undefined;
}

export abstract class SdkBackedServer implements McpServer {
  readonly name: string;

  protected client: Client | undefined;
  protected transport: Transport | undefined;
  protected remoteTools: Tool[] | undefined;
  private readonly toolFilter: ToolNameFilter;

  constructor(
    readonly config: ResolvedServerConfig,
    readonly profile: CompatibilityProfile,
  ) {
    this.name = config.name;
    this.toolFilter = createToolNameFilter(config);
  }

  abstract snapshot(): ServerSnapshot;
  abstract connect(signal?: AbortSignal): Promise<ServerSnapshot>;

  async getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult> {
    await this.connect(signal);
    return {
      server: this.snapshot(),
      tools: this.visibleTools() ?? [],
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult> {
    await this.connect(signal);
    this.requireAvailableTool(name);
    const client = this.requireClient();
    let result: CallToolResult;
    try {
      result = await client.callTool(
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

    return {
      server: this.snapshot(),
      toolName: name,
      args,
      result,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;

    this.client = undefined;
    this.transport = undefined;
    this.remoteTools = undefined;

    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  getServerDescription(): string | undefined {
    return this.client?.getServerVersion()?.description;
  }

  protected async openClient(signal?: AbortSignal): Promise<void> {
    const client = createBaseClient(this.name);
    const transport = this.createTransport();
    const requestOptions = signal ? { signal } : undefined;

    try {
      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, requestOptions);
      const remoteTools = listed.tools ?? [];
      const previousClient = this.client;
      const previousTransport = this.transport;

      this.client = client;
      this.transport = transport;
      this.remoteTools = remoteTools;

      await previousClient?.close().catch(() => {});
      await previousTransport?.close().catch(() => {});
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  protected visibleTools(): Tool[] | undefined {
    if (!this.remoteTools) {
      return undefined;
    }
    return applyToolNameFilter(this.remoteTools, this.toolFilter);
  }

  protected abstract createTransport(): Transport;

  private requireClient(): Client {
    if (!this.client) {
      throw new Error(`MCP server client is not open: ${this.name}`);
    }
    return this.client;
  }

  private requireAvailableTool(toolName: string): void {
    if (this.visibleTools()?.some(tool => tool.name === toolName)) {
      return;
    }

    if (this.remoteTools?.some(tool => tool.name === toolName) && isToolNameFilteredByConfig(toolName, this.toolFilter)) {
      throw new Error(`Tool "${toolName}" is excluded by configuration on MCP server "${this.name}".`);
    }

    throw new Error(`Tool "${toolName}" is not available on MCP server "${this.name}".`);
  }
}
