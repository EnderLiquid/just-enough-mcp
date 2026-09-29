import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  getOAuthCapabilityRemoteCode,
  type OAuthCapability,
} from "../capability.js";
import type { OAuthIdentity } from "./identity.ts";

/**
 * Session 侧的认证 fetch：这是唯一的 token 注入与认证修复入口。
 * MCP 的 connect、tools/list、tools/call 与 SSE GET 共用同一条路径，
 * 因此不需要在 `Client` 方法外层按 MCP 方法判断重放资格。
 */

/** 每次请求都向 broker 取 token，所以只要保证请求生命周期内不过期即可。 */
export const DEFAULT_OAUTH_REQUEST_MIN_REMAINING_MS = 30_000;

const AUTHORIZATION_HEADER = "authorization";
const WWW_AUTHENTICATE_HEADER = "www-authenticate";

export type OAuthAuthenticationFailureReason =
  | "authorization-required"
  | "resolution-failed"
  | "scope-not-granted"
  | "repair-failed"
  | "logout-refused";

/**
 * 认证层失败。`message` 面向用户，必须已经带上下一步操作建议；
 * 不得包含 token、client secret 或 PKCE 材料。
 */
export class OAuthAuthenticationError extends Error {
  readonly code = "oauth-authentication-failed" as const;
  readonly reason: OAuthAuthenticationFailureReason;

  constructor(reason: OAuthAuthenticationFailureReason, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthAuthenticationError";
    this.reason = reason;
  }
}

export interface AuthenticatedFetchOptions {
  readonly oauthCapability: OAuthCapability;
  readonly identity: OAuthIdentity;
  readonly serverName: string;
  /** 显式 oauth.scope 配置；token acquisition 与 scope challenge 都带上它以便状态判定。 */
  readonly scope?: string;
  readonly fetch?: FetchLike;
  readonly minRemainingMs?: number;
  /** 每完成一次修复后的重放或状态变化都会回调，供 server 侧同步 OAuth 状态缓存。 */
  readonly onOauthStateChange?: (state: "authorized" | "authorization-required") => void;
}

interface ChallengeParams {
  readonly resourceMetadataUrl?: string;
  readonly scope?: string;
  readonly error?: string;
}

/**
 * 按 decision 7.2 判定鉴权层拒绝。只有完整 401，或带 Bearer challenge 且
 * `error !== "insufficient_scope"` 的 403 才算；结果不明的失败不在此列。
 */
export function classifyAuthenticationFailure(status: number, headers: Headers): "repair" | "scope" | undefined {
  const challenge = parseBearerChallenge(headers.get(WWW_AUTHENTICATE_HEADER));
  if (status === 401) {
    return challenge.error === "insufficient_scope" ? "scope" : "repair";
  }
  if (status === 403 && challenge.present) {
    return challenge.error === "insufficient_scope" ? "scope" : "repair";
  }
  return undefined;
}

/**
 * 解析 `WWW-Authenticate: Bearer ...`。这里只需要 error/scope/resource_metadata 三个字段，
 * 因此不引入 SDK 内部解析器，避免对 `Response` 形态产生额外耦合。
 */
export function parseBearerChallenge(header: string | null): ChallengeParams & { readonly present: boolean } {
  if (!header) {
    return { present: false };
  }
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") {
    return { present: false };
  }
  const parameters = rest.join(" ");
  const resourceMetadataUrl = extractParameter(parameters, "resource_metadata");
  const scope = extractParameter(parameters, "scope");
  const error = extractParameter(parameters, "error");
  return {
    present: true,
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    ...(scope === undefined ? {} : { scope }),
    ...(error === undefined ? {} : { error }),
  };
}

function extractParameter(source: string, name: string): string | undefined {
  const quoted = new RegExp(`${name}="([^"]*)"`, "i").exec(source);
  if (quoted && quoted[1].length > 0) {
    return quoted[1];
  }
  const bare = new RegExp(`(?:^|[,\\s])${name}=([^,\\s]+)`, "i").exec(source);
  return bare?.[1];
}

/**
 * 无 token 的 MCP 探测：只用于显式 authorize 前获取初始 401 的 `resource_metadata`
 * 与 `scope`。任何失败都返回 undefined，由 broker 回退到 well-known discovery。
 */
export async function probeInitialChallenge(
  url: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ChallengeParams | undefined> {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) {
    signals.push(options.signal);
  }

  try {
    const response = await fetchImplementation(url, {
      method: "POST",
      headers: {
        ...(options.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      // `initialize` 是规范中未认证时的标准 401 触发点；未完成 initialize 前
      // 服务端不会把请求交给工具执行，因此探测没有副作用。
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "just-enough-mcp", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.any(signals),
    });
    if (response.status !== 401) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const challenge = parseBearerChallenge(response.headers.get(WWW_AUTHENTICATE_HEADER));
    await response.body?.cancel().catch(() => undefined);
    if (!challenge.present) {
      return undefined;
    }
    return {
      ...(challenge.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
      ...(challenge.scope === undefined ? {} : { scope: challenge.scope }),
    };
  } catch {
    return undefined;
  }
}

export function createAuthenticatedFetch(options: AuthenticatedFetchOptions): FetchLike {
  const fetchImplementation: FetchLike = options.fetch ?? fetch;
  const minRemainingMs = options.minRemainingMs ?? DEFAULT_OAUTH_REQUEST_MIN_REMAINING_MS;

  const acquireToken = async (rejectedCredentialRevision?: number) => {
    return await options.oauthCapability.getOAuthToken({
      identity: options.identity,
      minRemainingMs,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(rejectedCredentialRevision === undefined ? {} : { rejectedCredentialRevision }),
    });
  };

  return async (input, init) => {
    let snapshot;
    try {
      snapshot = await acquireToken();
    } catch (error) {
      throw translateBrokerError(error, options.serverName);
    }
    options.onOauthStateChange?.("authorized");

    let response = await send(fetchImplementation, input, init, snapshot.accessToken);
    let failure = isResponse(response) ? classifyAuthenticationFailure(response.status, response.headers) : undefined;
    if (failure !== "repair") {
      if (failure === "scope") {
        await reportScopeChallenge(response, options, snapshot.credentialRevision);
      }
      return response;
    }

    // 最多一次认证修复重放：用本次请求实际使用的 revision 换取新 token。
    await discard(response);
    let repaired;
    try {
      repaired = await acquireToken(snapshot.credentialRevision);
    } catch (error) {
      throw translateBrokerError(error, options.serverName, { repairing: true });
    }
    options.onOauthStateChange?.("authorized");

    response = await send(fetchImplementation, input, init, repaired.accessToken);
    failure = isResponse(response) ? classifyAuthenticationFailure(response.status, response.headers) : undefined;
    if (failure === "scope") {
      await reportScopeChallenge(response, options, repaired.credentialRevision);
      return response;
    }
    if (failure !== "repair") {
      return response;
    }

    await discard(response);
    await conditionalLogout(options, repaired.credentialRevision);
    throw new OAuthAuthenticationError(
      "repair-failed",
      `Authentication for MCP server "${options.serverName}" failed again after refreshing the access token. `
        + "Local credentials were cleared; run mcp_server authorize to sign in again.",
    );
  };
}

function isResponse(value: Response): value is Response {
  return typeof (value as { status?: unknown })?.status === "number";
}

async function send(
  fetchImplementation: FetchLike,
  input: string | URL,
  init: RequestInit | undefined,
  accessToken: string,
): Promise<Response> {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set(AUTHORIZATION_HEADER, `Bearer ${accessToken}`);
  return await fetchImplementation(input, { ...init, headers });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function reportScopeChallenge(
  response: Response,
  options: AuthenticatedFetchOptions,
  observedCredentialRevision: number,
): Promise<void> {
  const challenge = parseBearerChallenge(response.headers.get(WWW_AUTHENTICATE_HEADER));
  await discard(response);

  const challengedScope = challenge.scope;
  if (challengedScope === undefined) {
    throw new OAuthAuthenticationError(
      "scope-not-granted",
      `MCP server "${options.serverName}" requires additional OAuth scope but did not report which scope. `
        + "Run mcp_server authorize to re-authorize, then retry the call.",
    );
  }

  try {
    await options.oauthCapability.challengeScope({
      identity: options.identity,
      challengedScope,
      observedCredentialRevision,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
  } catch (error) {
    if (getOAuthCapabilityRemoteCode(error) === "scope-not-grantable") {
      throw new OAuthAuthenticationError(
        "scope-not-granted",
        `MCP server "${options.serverName}" requires the scope "${challengedScope}", which was already requested `
          + "and refused. Update the server's oauth.scope configuration instead of re-authorizing.",
      );
    }
    throw translateBrokerError(error, options.serverName);
  }

  throw new OAuthAuthenticationError(
    "scope-not-granted",
    `MCP server "${options.serverName}" requires additional OAuth scope "${challengedScope}". `
      + "Run mcp_server authorize to grant it, then retry the call.",
  );
}

async function conditionalLogout(
  options: AuthenticatedFetchOptions,
  expectedCredentialRevision: number,
): Promise<void> {
  try {
    const result = await options.oauthCapability.logoutOAuth({
      identity: options.identity,
      expectedCredentialRevision,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
    if (result.applied) {
      options.onOauthStateChange?.("authorization-required");
      return;
    }
    throw new OAuthAuthenticationError(
      "logout-refused",
      `Automatic authentication repair for MCP server "${options.serverName}" could not complete because the `
        + "credentials changed while the request was in flight. Retry later.",
    );
  } catch (error) {
    if (error instanceof OAuthAuthenticationError) {
      throw error;
    }
    throw new OAuthAuthenticationError(
      "logout-refused",
      `Automatic authentication repair for MCP server "${options.serverName}" could not complete because the `
        + "broker is unavailable. Retry later.",
      { cause: error },
    );
  }
}

function translateBrokerError(
  error: unknown,
  serverName: string,
  options: { repairing?: boolean } = {},
): Error {
  if (error instanceof OAuthAuthenticationError) {
    return error;
  }
  const repairing = options.repairing === true ? " while refreshing the access token" : "";
  const remoteCode = getOAuthCapabilityRemoteCode(error);
  if (remoteCode === "authorization-required") {
    return new OAuthAuthenticationError(
      "authorization-required",
      `MCP server "${serverName}" requires OAuth authorization. Run mcp_server authorize to sign in.`,
      { cause: error },
    );
  }
  if (remoteCode === "scope-not-granted") {
    return new OAuthAuthenticationError(
      "scope-not-granted",
      `MCP server "${serverName}" requires additional OAuth scope. Run mcp_server authorize, then retry the call.`,
      { cause: error },
    );
  }
  if (remoteCode === "credential-changed") {
    return new OAuthAuthenticationError(
      "resolution-failed",
      `OAuth credentials for MCP server "${serverName}" changed while the request was in flight. Retry later.`,
      { cause: error },
    );
  }
  if (remoteCode === "temporary-protocol-error") {
    return new OAuthAuthenticationError(
      "resolution-failed",
      `OAuth token refresh for MCP server "${serverName}" failed temporarily${repairing}. Retry later.`,
      { cause: error },
    );
  }
  if (remoteCode !== undefined) {
    return new OAuthAuthenticationError(
      "resolution-failed",
      `OAuth token acquisition for MCP server "${serverName}"${repairing} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return error instanceof Error
    ? error
    : new OAuthAuthenticationError(
        "resolution-failed",
        `OAuth token acquisition for MCP server "${serverName}" failed.`,
        { cause: error },
      );
}
