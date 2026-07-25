import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import { expectNonEmptyString, expectOptionalTransport } from "./config-helpers.js";
import { SdkToolSession } from "./sdk-tool-session.js";
import type { McpServer } from "./types.js";

export class HttpPublicServer implements McpServer {
  readonly name: string;
  private readonly session: SdkToolSession;

  constructor(readonly config: ResolvedServerConfig) {
    this.name = config.name;
    expectOptionalTransport(config.definition, config.name, "http");
    const url = expectNonEmptyString(config.definition, "url", config.name);

    this.session = new SdkToolSession({
      serverName: this.name,
      config,
      createTransport: () => new StreamableHTTPClientTransport(new URL(url)),
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
    await this.session.connect(signal);
    return this.snapshot();
  }

  async getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult> {
    const tools = await this.session.getTools(signal);
    return { server: this.snapshot(), tools };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult> {
    const result = await this.session.callTool(name, args, signal);
    return {
      server: this.snapshot(),
      toolName: name,
      args,
      result,
    };
  }

  close(): Promise<void> {
    return this.session.close();
  }

  getServerDescription(): string | undefined {
    return this.session.getServerDescription();
  }
}
