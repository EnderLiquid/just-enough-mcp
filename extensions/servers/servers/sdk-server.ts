import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CompatibilityProfile, ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import type { McpServer } from "./types.js";

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

export abstract class SdkBackedServer implements McpServer {
  readonly name: string;

  protected client: Client | undefined;
  protected transport: Transport | undefined;
  protected tools: Tool[] | undefined;

  constructor(
    readonly config: ResolvedServerConfig,
    readonly profile: CompatibilityProfile,
  ) {
    this.name = config.name;
  }

  abstract snapshot(): ServerSnapshot;
  abstract connect(): Promise<ServerSnapshot>;

  async getCatalog(): Promise<ServerCatalogResult> {
    await this.connect();
    return {
      server: this.snapshot(),
      tools: this.tools ?? [],
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult> {
    await this.connect();
    const client = this.requireClient();
    const result = await client.callTool({
      name,
      arguments: args,
    }) as CallToolResult;

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
    this.tools = undefined;

    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  getServerDescription(): string | undefined {
    return this.client?.getServerVersion()?.description;
  }

  protected async openClient(): Promise<void> {
    const client = createBaseClient(this.name);
    const transport = this.createTransport();

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const previousClient = this.client;
      const previousTransport = this.transport;

      this.client = client;
      this.transport = transport;
      this.tools = listed.tools ?? [];

      await previousClient?.close().catch(() => {});
      await previousTransport?.close().catch(() => {});
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  protected abstract createTransport(): Transport;

  private requireClient(): Client {
    if (!this.client) {
      throw new Error(`MCP server client is not open: ${this.name}`);
    }
    return this.client;
  }
}
