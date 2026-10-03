import type {
  ResolvedServerConfig,
  ResolvedOauthConfig,
} from "../../modeling/types.js";

export interface OauthHttpServerConfig {
  url: URL;
  headers?: Record<string, string>;
  clientMetadataUrl?: string;
  scope?: string;
  profile: string;
}

export function getOauthHttpServerConfig(config: ResolvedServerConfig): OauthHttpServerConfig {
  const transport = config.transport;
  if (transport.kind !== "http" || transport.auth !== "oauth" || transport.oauth === undefined) {
    throw new Error(`Server "${config.name}" does not contain a resolved OAuth HTTP configuration.`);
  }

  const oauth: ResolvedOauthConfig = transport.oauth;
  return {
    url: transport.url,
    ...(transport.headers === undefined ? {} : { headers: transport.headers }),
    ...(oauth.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: oauth.clientMetadataUrl }),
    ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
    profile: oauth.profile,
  };
}
