import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthIdentity } from "./identity.ts";

/** adapter 返回的 discovery 结果；persistence 层再补 fetchedAt 形成 OAuthDiscoveryRecord。 */
export interface OAuthDiscoveryResult {
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly resourceMetadata?: OAuthProtectedResourceMetadata;
}

export interface OAuthDiscoveryRequest {
  readonly identity: OAuthIdentity;
  /** session 转发的 PRM URL；提供时作为 discovery 的首选路径。 */
  readonly resourceMetadataUrl?: string;
}

export type OAuthDiscoveryOperation = (
  request: OAuthDiscoveryRequest,
) => Promise<OAuthDiscoveryResult>;

export interface OAuthRegistrationRequest {
  readonly identity: OAuthIdentity;
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly clientMetadata: OAuthClientMetadata;
  readonly scope?: string;
}

export type OAuthRegistrationOperation = (
  request: OAuthRegistrationRequest,
) => Promise<OAuthClientInformationFull>;

export interface OAuthAuthorizationUrlRequest {
  readonly identity: OAuthIdentity;
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformationFull;
  readonly redirectUrl: string;
  readonly state: string;
  readonly scope?: string;
}

/** startAuthorization 的结果；codeVerifier 只留在 broker 内存。 */
export interface OAuthAuthorizationUrlResult {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
}

export type OAuthAuthorizationUrlOperation = (
  request: OAuthAuthorizationUrlRequest,
) => Promise<OAuthAuthorizationUrlResult>;

export interface OAuthCodeExchangeRequest {
  readonly identity: OAuthIdentity;
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformationFull;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUrl: string;
  readonly resource: URL;
}

export type OAuthCodeExchangeOperation = (
  request: OAuthCodeExchangeRequest,
) => Promise<OAuthTokens>;
