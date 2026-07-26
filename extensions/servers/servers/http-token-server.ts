import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import { expectNonEmptyString, expectOptionalString, expectOptionalStringRecord, expectOptionalTransport } from "./config-helpers.js";
import { SdkToolSession } from "./sdk-tool-session.js";
import type { McpServer } from "./types.js";

export class HttpTokenServer implements McpServer {
  readonly name: string;
  private readonly session: SdkToolSession;

  constructor(readonly config: ResolvedServerConfig) {
    this.name = config.name;
    expectOptionalTransport(config.definition, config.name, "http");
    const url = expectNonEmptyString(config.definition, "url", config.name);
    const configuredHeaders = expectOptionalStringRecord(config.definition, "headers", config.name);
    const bearerToken = expectOptionalString(config.definition, "bearerToken", config.name);
    const headers = { ...(configuredHeaders ?? {}) };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    this.session = new SdkToolSession({
      serverName: this.name,
      config,
      createTransport: () => new StreamableHTTPClientTransport(new URL(url), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      }),
    });
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      connectState: this.session.state,
      tools: this.session.tools,
    };
  }

  async connect(signal?: AbortSignal): Promise<ServerSnapshot> {
    const snapshot = await this.session.connect(signal);
    return { name: this.name, ...snapshot };
  }

  async getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult> {
    const catalog = await this.session.getTools(signal);
    return {
      server: { name: this.name, ...catalog.snapshot },
      tools: catalog.tools,
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult> {
    const execution = await this.session.callTool(name, args, signal);
    return {
      server: { name: this.name, ...execution.snapshot },
      toolName: name,
      args,
      result: execution.result,
    };
  }

  async close(): Promise<ServerSnapshot> {
    const snapshot = await this.session.close();
    return { name: this.name, ...snapshot };
  }

  getServerDescription(): string | undefined {
    return this.session.getServerDescription();
  }
}
