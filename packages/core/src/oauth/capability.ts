import type {
  OAuthBrokerAuthorizeRequest,
  OAuthBrokerAuthorizeResult,
  OAuthBrokerIdentityRequest,
  OAuthBrokerLogoutRequest,
  OAuthBrokerLogoutResult,
  OAuthBrokerScopeChallengeRequest,
  OAuthBrokerScopeChallengeResult,
  OAuthBrokerStatusResult,
  OAuthBrokerTokenRequest,
  OAuthBrokerTokenResult,
} from "./broker/protocol.js";

export interface OAuthCapabilityRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OAuthCapability {
  getOAuthStatus(
    params: OAuthBrokerIdentityRequest,
    options?: OAuthCapabilityRequestOptions,
  ): Promise<OAuthBrokerStatusResult>;
  getOAuthToken(
    params: OAuthBrokerTokenRequest,
    options?: OAuthCapabilityRequestOptions,
  ): Promise<OAuthBrokerTokenResult>;
  logoutOAuth(
    params: OAuthBrokerLogoutRequest,
    options?: OAuthCapabilityRequestOptions,
  ): Promise<OAuthBrokerLogoutResult>;
  challengeScope(
    params: OAuthBrokerScopeChallengeRequest,
    options?: OAuthCapabilityRequestOptions,
  ): Promise<OAuthBrokerScopeChallengeResult>;
  authorizeOAuth(
    params: OAuthBrokerAuthorizeRequest,
    options?: OAuthCapabilityRequestOptions,
  ): Promise<OAuthBrokerAuthorizeResult>;
}

export function getOAuthCapabilityRemoteCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const remoteCode = (error as { remoteCode?: unknown }).remoteCode;
  return typeof remoteCode === "string" ? remoteCode : undefined;
}
