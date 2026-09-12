import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidScopeError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthTokenUpdate } from "./credential-state.ts";
import type { OAuthDiscoveryResult } from "./oauth-protocol-types.ts";
import {
  OAuthAuthorizationRequiredError,
  OAuthClientRejectedError,
  OAuthPermanentRefreshError,
  OAuthTemporaryProtocolError,
  type OAuthRefreshOperation,
} from "./token-coordinator.ts";

export const DEFAULT_OAUTH_PROTOCOL_TIMEOUT_MS = 10_000;
export const DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;

/**
 * 只做网络调用与错误分类；不读写 repository，也不决定 single-flight 或提交顺序。
 * OAuth domain error 一律映射为 token-coordinator 的错误类型。
 */
export interface OAuthProtocolAdapter {
  discover(resourceUrl: string): Promise<OAuthDiscoveryResult>;
  register(params: {
    readonly authorizationServerUrl: string;
    readonly clientMetadata: OAuthClientMetadata;
    readonly metadata?: AuthorizationServerMetadata;
    readonly scope?: string;
  }): Promise<OAuthClientInformationFull>;
  refresh(params: {
    readonly authorizationServerUrl: string;
    readonly clientInformation: OAuthClientInformationFull;
    readonly refreshToken: string;
    readonly metadata?: AuthorizationServerMetadata;
    readonly resource?: URL;
  }): Promise<OAuthTokens>;
}

export interface OAuthProtocolAdapterOptions {
  readonly fetchFn?: FetchLike;
  readonly timeoutMs?: number;
}

export function createOAuthProtocolAdapter(
  options: OAuthProtocolAdapterOptions = {},
): OAuthProtocolAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_PROTOCOL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number.");
  }
  const fetchFn = createTimedFetch(options.fetchFn ?? fetch, timeoutMs);

  return {
    async discover(resourceUrl) {
      try {
        const info = await discoverOAuthServerInfo(resourceUrl, { fetchFn });
        return {
          authorizationServerUrl: info.authorizationServerUrl,
          ...(info.authorizationServerMetadata
            ? { authorizationServerMetadata: info.authorizationServerMetadata }
            : {}),
          ...(info.resourceMetadata ? { resourceMetadata: info.resourceMetadata } : {}),
        };
      } catch (error) {
        throw classifyProtocolError(error);
      }
    },

    async register(params) {
      try {
        return await registerClient(params.authorizationServerUrl, {
          ...(params.metadata ? { metadata: params.metadata } : {}),
          clientMetadata: params.clientMetadata,
          ...(params.scope === undefined ? {} : { scope: params.scope }),
          fetchFn,
        });
      } catch (error) {
        throw classifyProtocolError(error);
      }
    },

    async refresh(params) {
      try {
        return await refreshAuthorization(params.authorizationServerUrl, {
          ...(params.metadata ? { metadata: params.metadata } : {}),
          clientInformation: params.clientInformation,
          refreshToken: params.refreshToken,
          ...(params.resource ? { resource: params.resource } : {}),
          fetchFn,
        });
      } catch (error) {
        throw classifyProtocolError(error);
      }
    },
  };
}

export interface OAuthRefreshOperationOptions {
  readonly adapter: OAuthProtocolAdapter;
  readonly now?: () => number;
  /** token response 缺失或非法 expires_in 的 fallback 寿命。 */
  readonly defaultAccessTokenLifetimeMs?: number;
}

/**
 * 把 coordinator 的 refresh 请求接到 protocol adapter：解析 registration、
 * 携带 resource indicator，并把 token response 归一化为 credential update。
 */
export function createOAuthRefreshOperation(
  options: OAuthRefreshOperationOptions,
): OAuthRefreshOperation {
  const now = options.now ?? (() => Date.now());
  const defaultLifetimeMs =
    options.defaultAccessTokenLifetimeMs ?? DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_MS;

  return async request => {
    const registration = request.registration;
    if (!registration) {
      // 没有 registration 说明本进程从未为该 identity 完成过授权；只有显式 authorize 能恢复。
      throw new OAuthAuthorizationRequiredError();
    }
    const tokens = await options.adapter.refresh({
      authorizationServerUrl: registration.authorizationServerUrl,
      clientInformation: registration.clientInformation,
      refreshToken: request.refreshToken,
      ...(request.authorizationServerMetadata
        ? { metadata: request.authorizationServerMetadata }
        : {}),
      resource: new URL(request.identity.resourceUrl),
    });
    const update: OAuthTokenUpdate = {
      accessToken: tokens.access_token,
      accessTokenExpiresAt: now() + resolveAccessTokenLifetimeMs(tokens.expires_in, defaultLifetimeMs),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
    return update;
  };
}

function resolveAccessTokenLifetimeMs(
  expiresIn: number | undefined,
  fallbackMs: number,
): number {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn * 1_000
    : fallbackMs;
}

function createTimedFetch(baseFetch: FetchLike, timeoutMs: number): FetchLike {
  return (url, init) => baseFetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function classifyProtocolError(error: unknown): Error {
  if (error instanceof InvalidGrantError) {
    return new OAuthPermanentRefreshError(
      "OAuth refresh credential was rejected by the authorization server.",
      { cause: error, reason: "invalid-grant" },
    );
  }
  if (error instanceof InvalidScopeError) {
    return new OAuthPermanentRefreshError(
      "OAuth authorization server rejected the scope set of the current grant.",
      { cause: error, reason: "invalid-scope" },
    );
  }
  if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
    return new OAuthClientRejectedError(
      "OAuth client registration was rejected by the authorization server.",
      { cause: error },
    );
  }
  return new OAuthTemporaryProtocolError(
    "OAuth protocol request failed without a conclusive result.",
    { cause: error },
  );
}
