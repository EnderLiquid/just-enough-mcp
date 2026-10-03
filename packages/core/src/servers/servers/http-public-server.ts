import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import type { OverviewBootstrapper } from "../../overview/overview-bootstrapper.js";
import { SdkSessionManager } from "./sdk-session-manager.js";
import type { McpServer } from "./types.js";

export class HttpPublicServer implements McpServer {
  readonly name: string;
  private readonly session: SdkSessionManager;

  constructor(
    readonly config: ResolvedServerConfig,
    overviewBootstrapper?: OverviewBootstrapper,
  ) {
    this.name = config.name;
    if (config.transport.kind !== "http" || config.transport.auth !== "public") {
      throw new Error(`Server "${config.name}" does not contain a resolved public HTTP configuration.`);
    }

    const transport = config.transport;
    this.session = new SdkSessionManager({
      serverName: this.name,
      config,
      overviewBootstrapper,
      createTransport: () => new StreamableHTTPClientTransport(transport.url),
    });
  }

  snapshot(): ServerSnapshot {
    return { name: this.name, ...this.session.snapshot() };
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
}
