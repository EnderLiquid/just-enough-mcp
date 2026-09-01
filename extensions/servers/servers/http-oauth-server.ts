import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../../modeling/types.js";
import type { OauthSessionServices } from "../../oauth/session-services.js";
import { parseOauthHttpServerConfig } from "./oauth-config.js";
import { OauthSdkSessionManager } from "./oauth-sdk-session-manager.js";
import type { McpServer } from "./types.js";

export class HttpOauthServer implements McpServer {
  readonly name: string;
  private readonly session: OauthSdkSessionManager;

  constructor(
    readonly config: ResolvedServerConfig,
    services: OauthSessionServices,
  ) {
    this.name = config.name;
    const oauthConfig = parseOauthHttpServerConfig(config);
    this.session = new OauthSdkSessionManager({
      serverName: this.name,
      config,
      serverUrl: oauthConfig.url,
      ...(oauthConfig.headers ? { requestHeaders: oauthConfig.headers } : {}),
      ...(oauthConfig.clientMetadataUrl ? { clientMetadataUrl: oauthConfig.clientMetadataUrl } : {}),
      ...(oauthConfig.scope ? { scope: oauthConfig.scope } : {}),
      services,
    });
  }

  snapshot(): ServerSnapshot {
    return { name: this.name, ...this.session.snapshot() };
  }

  async connect(signal?: AbortSignal): Promise<ServerSnapshot> {
    const snapshot = await this.session.connect(signal);
    return { name: this.name, ...snapshot };
  }

  async authorize(signal?: AbortSignal): Promise<ServerSnapshot> {
    const snapshot = await this.session.authorize(signal);
    return { name: this.name, ...snapshot };
  }

  async logout(): Promise<ServerSnapshot> {
    const snapshot = await this.session.logout();
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
