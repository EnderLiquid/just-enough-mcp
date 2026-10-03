import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import type { OverviewBootstrapper } from "../../overview/overview-bootstrapper.js";
import { SdkSessionManager } from "./sdk-session-manager.js";
import type { McpServer } from "./types.js";

export class StdioPragmaticServer implements McpServer {
  readonly name: string;
  private readonly session: SdkSessionManager;

  constructor(
    readonly config: ResolvedServerConfig,
    overviewBootstrapper?: OverviewBootstrapper,
  ) {
    this.name = config.name;
    if (config.transport.kind !== "stdio") {
      throw new Error(`Server "${config.name}" does not contain a resolved stdio configuration.`);
    }

    const transport = config.transport;
    this.session = new SdkSessionManager({
      serverName: this.name,
      config,
      overviewBootstrapper,
      createTransport: () => new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        cwd: transport.cwd,
        env: transport.env,
        stderr: "ignore",
      }),
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
    callArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult> {
    const execution = await this.session.callTool(name, callArgs, signal);
    return {
      server: { name: this.name, ...execution.snapshot },
      toolName: name,
      args: callArgs,
      result: execution.result,
    };
  }

  async close(): Promise<ServerSnapshot> {
    const snapshot = await this.session.close();
    return { name: this.name, ...snapshot };
  }
}
