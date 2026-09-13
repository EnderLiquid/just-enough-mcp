import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerOauthState,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../../modeling/types.js";
import type { OAuthBrokerClient } from "../../oauth/broker/client.js";
import { createOAuthIdentity, type OAuthIdentity } from "../../oauth/broker/identity.js";
import { parseOauthHttpServerConfig } from "./oauth-config.js";
import type { McpServer } from "./types.js";

export class OauthNotSupportedError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is configured with OAuth, but OAuth MCP connections are not implemented yet.`);
    this.name = "OauthNotSupportedError";
  }
}

export interface UnsupportedOauthServerDependencies {
  readonly brokerClient: OAuthBrokerClient;
  readonly namespaceId: string;
}

/**
 * Phase 3 OAuth server adapter. It exposes broker-backed status/logout while keeping
 * MCP connection and interactive authorization disabled until their dedicated phases.
 * The broker client is borrowed from the plugin root and is never closed here.
 */
export class UnsupportedOauthServer implements McpServer {
  readonly name: string;

  private readonly brokerClient: OAuthBrokerClient | undefined;
  private readonly identity: OAuthIdentity | undefined;
  private readonly scope: string | undefined;
  private knownOauthState: Exclude<ServerOauthState, "unknown"> | undefined;

  constructor(
    readonly config: ResolvedServerConfig,
    dependencies?: UnsupportedOauthServerDependencies,
  ) {
    this.name = config.name;
    const oauth = parseOauthHttpServerConfig(config);
    this.scope = oauth.scope;
    this.brokerClient = dependencies?.brokerClient;
    this.identity = dependencies === undefined
      ? undefined
      : createOAuthIdentity({
          namespaceId: dependencies.namespaceId,
          resourceUrl: oauth.url,
          clientMetadataUrl: oauth.clientMetadataUrl,
          profile: oauth.profile,
          requestHeaders: oauth.headers,
        });
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      connectState: "disconnected",
      ...(this.brokerClient
        ? { oauthState: this.knownOauthState ?? "unknown" }
        : {}),
    };
  }

  async status(): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      return this.snapshot();
    }
    try {
      const status = await this.brokerClient.getOAuthStatus({
        identity: this.identity,
        ...(this.scope === undefined ? {} : { scope: this.scope }),
      });
      this.knownOauthState = status.oauthState;
      return this.snapshot();
    } catch {
      // `unknown` is a transient observation. Keep the last known broker state cached.
      return {
        name: this.name,
        connectState: "disconnected",
        oauthState: "unknown",
      };
    }
  }

  async connect(): Promise<ServerSnapshot> {
    throw this.unsupported();
  }

  async authorize(signal?: AbortSignal): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      throw this.unsupported();
    }
    const result = await this.brokerClient.authorizeOAuth({
      identity: this.identity,
      ...(this.scope === undefined ? {} : { scope: this.scope }),
    }, signal === undefined ? {} : { signal });
    this.knownOauthState = result.oauthState;
    return this.snapshot();
  }

  async logout(): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      throw this.unsupported();
    }
    const result = await this.brokerClient.logoutOAuth({
      identity: this.identity,
      ...(this.scope === undefined ? {} : { scope: this.scope }),
    });
    this.knownOauthState = result.oauthState;
    return this.snapshot();
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
