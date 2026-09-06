import type { ResolvedServerConfig, ServerDefinition } from "../../modeling/types.js";
import {
  expectNonEmptyString,
  expectOptionalStringRecord,
  expectOptionalTransport,
} from "./config-helpers.js";

export interface OauthHttpServerConfig {
  url: URL;
  headers?: Record<string, string>;
  clientMetadataUrl?: string;
  scope?: string;
  profile: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOauthAuthentication(definition: ServerDefinition, serverName: string): boolean {
  const auth = definition.auth;
  if (auth === undefined) {
    if (definition.oauth !== undefined) {
      throw new Error(`Server "${serverName}" provides oauth settings but auth is not "oauth".`);
    }
    return false;
  }

  if (auth !== "oauth") {
    throw new Error(`Server "${serverName}" auth must be "oauth" when provided.`);
  }
  return true;
}

function expectOptionalOauthSetting(
  definition: ServerDefinition,
  serverName: string,
  fieldName: "clientMetadataUrl" | "scope" | "profile",
): string | undefined {
  if (definition.oauth === undefined) {
    return undefined;
  }
  if (!isObject(definition.oauth)) {
    throw new Error(`Server "${serverName}" oauth must be an object.`);
  }

  const value = definition.oauth[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Server "${serverName}" oauth.${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function expectClientMetadataUrl(definition: ServerDefinition, serverName: string): string | undefined {
  const value = expectOptionalOauthSetting(definition, serverName, "clientMetadataUrl");
  if (!value) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Server "${serverName}" oauth.clientMetadataUrl must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.pathname === "/") {
    throw new Error(`Server "${serverName}" oauth.clientMetadataUrl must be an HTTPS URL with a non-root path.`);
  }
  return url.toString();
}

function expectHttpUrl(definition: ServerDefinition, serverName: string): URL {
  const value = expectNonEmptyString(definition, "url", serverName);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Server "${serverName}" url must be a valid HTTP URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Server "${serverName}" url must use http or https.`);
  }
  return url;
}

function rejectsStaticOAuthConflicts(
  definition: ServerDefinition,
  serverName: string,
  headers: Record<string, string> | undefined,
): void {
  if (definition.bearerToken !== undefined) {
    throw new Error(`Server "${serverName}" cannot combine auth "oauth" with bearerToken.`);
  }
  if (headers && Object.keys(headers).some(name => name.toLowerCase() === "authorization")) {
    throw new Error(`Server "${serverName}" cannot combine auth "oauth" with headers.Authorization.`);
  }
}

export function parseOauthHttpServerConfig(config: ResolvedServerConfig): OauthHttpServerConfig {
  expectOptionalTransport(config.definition, config.name, "http");
  if (!hasOauthAuthentication(config.definition, config.name)) {
    throw new Error(`Server "${config.name}" auth must be "oauth".`);
  }

  const headers = expectOptionalStringRecord(config.definition, "headers", config.name);
  rejectsStaticOAuthConflicts(config.definition, config.name, headers);
  const scope = expectOptionalOauthSetting(config.definition, config.name, "scope");
  const profile = expectOptionalOauthSetting(config.definition, config.name, "profile") ?? "default";
  const clientMetadataUrl = expectClientMetadataUrl(config.definition, config.name);

  return {
    url: expectHttpUrl(config.definition, config.name),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(scope ? { scope } : {}),
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    profile,
  };
}

export function rejectOauthWithStdio(config: ResolvedServerConfig): void {
  if (hasOauthAuthentication(config.definition, config.name)) {
    throw new Error(`Server "${config.name}" auth "oauth" requires transport "http".`);
  }
}
