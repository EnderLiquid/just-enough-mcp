import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ResolvedServerConfig,
  ServerCatalogResult,
  ServerOauthState,
  ServerSnapshot,
  ToolCallExecutionResult,
} from "../../modeling/types.js";
import type { OAuthBrokerClient } from "../../oauth/broker/client.ts";
import { OAuthBrokerClientError } from "../../oauth/broker/client.ts";
import {
  createAuthenticatedFetch,
  probeInitialChallenge,
  type OAuthAuthenticationError,
} from "../../oauth/broker/authenticated-fetch.ts";
import { createOAuthIdentity, type OAuthIdentity } from "../../oauth/broker/identity.ts";
import { parseOauthHttpServerConfig, type OauthHttpServerConfig } from "./oauth-config.js";
import { SdkSessionManager } from "./sdk-session-manager.js";
import type { McpServer } from "./types.js";

export interface OauthHttpServerDependencies {
  readonly brokerClient: OAuthBrokerClient;
  readonly namespaceId: string;
  /** 认证探测请求的超时；测试用小值。 */
  readonly probeTimeoutMs?: number;
}

/**
 * OAuth 保护的 HTTP MCP server。鉴权与认证修复全部发生在 authenticated fetch 层，
 * MCP `Client`/transport 只用本地 connection 与 catalog 生命周期，不参与 OAuth 编排。
 */
export class OauthHttpServer implements McpServer {
  readonly name: string;

  private readonly oauthConfig: OauthHttpServerConfig;
  private readonly brokerClient: OAuthBrokerClient | undefined;
  private readonly identity: OAuthIdentity | undefined;
  private readonly probeTimeoutMs: number | undefined;
  private readonly session: SdkSessionManager;
  private knownOauthState: Exclude<ServerOauthState, "unknown"> | undefined;

  constructor(
    readonly config: ResolvedServerConfig,
    dependencies?: OauthHttpServerDependencies,
  ) {
    this.name = config.name;
    this.oauthConfig = parseOauthHttpServerConfig(config);
    this.brokerClient = dependencies?.brokerClient;
    this.identity = dependencies === undefined
      ? undefined
      : createOAuthIdentity({
          namespaceId: dependencies.namespaceId,
          resourceUrl: this.oauthConfig.url,
          clientMetadataUrl: this.oauthConfig.clientMetadataUrl,
          profile: this.oauthConfig.profile,
          requestHeaders: this.oauthConfig.headers,
        });
    this.probeTimeoutMs = dependencies?.probeTimeoutMs;

    this.session = new SdkSessionManager({
      serverName: this.name,
      config,
      createTransport: () => new StreamableHTTPClientTransport(this.oauthConfig.url, {
        fetch: this.createFetch(),
        ...(this.oauthConfig.headers === undefined
          ? {}
          : { requestInit: { headers: this.oauthConfig.headers } }),
      }),
    });
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      ...this.session.snapshot(),
      ...this.snapshotOauthState(),
    };
  }

  async status(): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      return this.snapshot();
    }
    try {
      const status = await this.brokerClient.getOAuthStatus({
        identity: this.identity,
        ...(this.oauthConfig.scope === undefined ? {} : { scope: this.oauthConfig.scope }),
      });
      this.knownOauthState = status.oauthState;
      return this.snapshot();
    } catch {
      // `unknown` 只是本次观测；已知状态缓存保留，不覆盖。
      return {
        name: this.name,
        connectState: this.session.snapshot().connectState,
        tools: this.session.snapshot().tools,
        oauthState: "unknown",
      };
    }
  }

  async connect(signal?: AbortSignal): Promise<ServerSnapshot> {
    try {
      await this.session.connect(signal);
    } catch (error) {
      throw this.normalizeAuthenticationError(error);
    }
    return this.snapshot();
  }

  async getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult> {
    try {
      const catalog = await this.session.getTools(signal);
      return {
        server: {
          name: this.name,
          ...catalog.snapshot,
          ...this.snapshotOauthState(),
        },
        tools: catalog.tools,
      };
    } catch (error) {
      throw this.normalizeAuthenticationError(error);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult> {
    try {
      const execution = await this.session.callTool(name, args, signal);
      return {
        server: {
          name: this.name,
          ...execution.snapshot,
          ...this.snapshotOauthState(),
        },
        toolName: name,
        args,
        result: execution.result,
      };
    } catch (error) {
      throw this.normalizeAuthenticationError(error);
    }
  }

  /**
   * 显式授权：先尽力做一次无 token 的 MCP 探测获取初始 401 challenge，
   * 再交给 broker 完成交互授权。探测失败或没有目标参数时静默回退。
   * authorize 成功后不自动 connect，连接与授权生命周期保持解耦。
   */
  async authorize(signal?: AbortSignal): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      throw new OAuthAuthorizationUnavailableError(this.name);
    }
    const challenge = await probeInitialChallenge(this.oauthConfig.url.toString(), {
      ...(this.oauthConfig.headers === undefined ? {} : { headers: this.oauthConfig.headers }),
      ...(this.probeTimeoutMs === undefined ? {} : { timeoutMs: this.probeTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    const result = await this.brokerClient.authorizeOAuth({
      identity: this.identity,
      ...(this.oauthConfig.scope === undefined ? {} : { scope: this.oauthConfig.scope }),
      ...(challenge?.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
      ...(challenge?.scope === undefined ? {} : { initialChallengeScope: challenge.scope }),
    }, signal === undefined ? {} : { signal });
    this.knownOauthState = result.oauthState;
    return this.snapshot();
  }

  async logout(): Promise<ServerSnapshot> {
    if (!this.brokerClient || !this.identity) {
      throw new OAuthAuthorizationUnavailableError(this.name);
    }
    const result = await this.brokerClient.logoutOAuth({
      identity: this.identity,
      ...(this.oauthConfig.scope === undefined ? {} : { scope: this.oauthConfig.scope }),
    });
    this.knownOauthState = result.oauthState;
    // logout 不关闭 session-local MCP connection；已有 catalog 仍然有效。
    return this.snapshot();
  }

  async close(): Promise<ServerSnapshot> {
    await this.session.close();
    return this.snapshot();
  }

  private createFetch(): typeof fetch {
    if (!this.brokerClient || !this.identity) {
      // 缺少 broker dependency 时保持 fail-closed：请求不带 token，由 401 暴露配置问题。
      return ((input, init) => fetch(input as RequestInfo, init)) as typeof fetch;
    }
    return createAuthenticatedFetch({
      brokerClient: this.brokerClient,
      identity: this.identity,
      serverName: this.name,
      ...(this.oauthConfig.scope === undefined ? {} : { scope: this.oauthConfig.scope }),
      onOauthStateChange: state => {
        this.knownOauthState = state;
      },
    }) as typeof fetch;
  }

  /** OAuth server 的 oauthState 总是有意义；缺少 broker 时降为 unknown。 */
  private snapshotOauthState(): Pick<ServerSnapshot, "oauthState"> {
    return { oauthState: this.knownOauthState ?? "unknown" };
  }

  private normalizeAuthenticationError(error: unknown): Error {
    if (isAuthenticationError(error)) {
      this.knownOauthState = error.reason === "authorization-required" || error.reason === "repair-failed"
        ? "authorization-required"
        : this.knownOauthState;
      return error;
    }
    if (error instanceof OAuthBrokerClientError
      && error.remoteCode === "authorization-required") {
      this.knownOauthState = "authorization-required";
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export class OAuthAuthorizationUnavailableError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is configured with OAuth, but no OAuth broker is available.`);
    this.name = "OAuthAuthorizationUnavailableError";
  }
}

function isAuthenticationError(error: unknown): error is OAuthAuthenticationError {
  return (error as { code?: unknown })?.code === "oauth-authentication-failed";
}
