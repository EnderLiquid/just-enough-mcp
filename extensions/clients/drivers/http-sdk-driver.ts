import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerSpec } from "../../modeling/types.js";
import type { ServerTransportConfig } from "../../modeling/types.js";
import type { ServerDriver } from "./types.js";

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

type HttpResolvedServerSpec = Extract<ResolvedServerSpec, ServerTransportConfig & { transport: "http" }>;

export class HttpSdkDriver implements ServerDriver {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(private readonly config: HttpResolvedServerSpec) {}

  async open(): Promise<void> {
    if (this.client && this.transport) {
      return;
    }

    const headers = { ...(this.config.headers ?? {}) };
    if (this.config.bearerToken) {
      headers.Authorization = `Bearer ${this.config.bearerToken}`;
    }

    const client = createBaseClient(this.config.name);
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });

    await client.connect(transport);

    this.client = client;
    this.transport = transport;
  }

  getServerDescription(): string | undefined {
    return this.client?.getServerVersion()?.description;
  }

  async listTools(): Promise<Tool[]> {
    const client = this.requireClient();
    const listed = await client.listTools();
    return listed.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = this.requireClient();
    return client.callTool({
      name,
      arguments: args,
    }) as Promise<CallToolResult>;
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;

    this.client = undefined;
    this.transport = undefined;

    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error(`MCP server driver is not open: ${this.config.name}`);
    }
    return this.client;
  }
}
