import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../../modeling/types.js";
import { parseOauthHttpServerConfig } from "./oauth-config.js";
import type { McpServer } from "./types.js";

export class OauthNotSupportedError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is configured with OAuth, but OAuth support is temporarily disabled.`);
    this.name = "OauthNotSupportedError";
  }
}

/**
 * OAuth broker 重构期间的显式占位实现。
 *
 * 它只负责保留配置边界和 server assembly contract，不启动网络、浏览器、
 * callback listener 或 credential storage。新 OAuth runtime 不应从这里演进。
 */
export class UnsupportedOauthServer implements McpServer {
  readonly name: string;

  constructor(readonly config: ResolvedServerConfig) {
    this.name = config.name;
    parseOauthHttpServerConfig(config);
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      connectState: "disconnected",
    };
  }

  async connect(): Promise<ServerSnapshot> {
    throw this.unsupported();
  }

  async authorize(): Promise<ServerSnapshot> {
    throw this.unsupported();
  }

  async logout(): Promise<ServerSnapshot> {
    throw this.unsupported();
  }

  async getCatalog(): Promise<ServerCatalogResult> {
    throw this.unsupported();
  }

  async callTool(
    _name: string,
    _args: Record<string, unknown>,
  ): Promise<ToolCallExecutionResult> {
    throw this.unsupported();
  }

  async close(): Promise<ServerSnapshot> {
    return this.snapshot();
  }

  private unsupported(): OauthNotSupportedError {
    return new OauthNotSupportedError(this.name);
  }
}
