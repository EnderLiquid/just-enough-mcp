import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
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
