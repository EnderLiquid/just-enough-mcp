import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import { expectNonEmptyString, expectOptionalString, expectOptionalStringArray, expectOptionalStringRecord, expectOptionalTransport } from "./config-helpers.js";
import { SdkSessionManager } from "./sdk-session-manager.js";
import type { McpServer } from "./types.js";

export class StdioPragmaticServer implements McpServer {
  readonly name: string;
  private readonly session: SdkSessionManager;

  constructor(readonly config: ResolvedServerConfig) {
    this.name = config.name;
    expectOptionalTransport(config.definition, config.name, "stdio");
    const command = expectNonEmptyString(config.definition, "command", config.name);
    const args = expectOptionalStringArray(config.definition, "args", config.name);
    const cwd = expectOptionalString(config.definition, "cwd", config.name);
    const env = expectOptionalStringRecord(config.definition, "env", config.name);

    this.session = new SdkSessionManager({
      serverName: this.name,
      config,
      createTransport: () => new StdioClientTransport({
        command,
        args,
        cwd,
        env,
        stderr: "ignore",
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

  getServerDescription(): string | undefined {
    return this.session.getServerDescription();
  }
}
