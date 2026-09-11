import type { ResolvedServerConfig, ServerDefinition } from "../../modeling/types.js";
import {
  UnsupportedOauthServer,
  type UnsupportedOauthServerDependencies,
} from "./unsupported-oauth-server.js";
import { HttpPublicServer } from "./http-public-server.js";
import { HttpTokenServer } from "./http-token-server.js";
import { hasOauthAuthentication, rejectOauthWithStdio } from "./oauth-config.js";
import { StdioPragmaticServer } from "./stdio-pragmatic-server.js";
import type { McpServer } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyStringField(definition: ServerDefinition, fieldName: string): boolean {
  const value = definition[fieldName];
  return typeof value === "string" && value.length > 0;
}

function hasStaticAuth(definition: ServerDefinition): boolean {
  if (definition.bearerToken !== undefined) {
    return true;
  }

  if (definition.headers === undefined) {
    return false;
  }

  if (!isObject(definition.headers)) {
    return true;
  }

  return Object.keys(definition.headers).length > 0;
}

function resolveTransportHint(config: ResolvedServerConfig): "stdio" | "http" {
  const explicitTransport = config.definition.transport;
  if (explicitTransport === "stdio" || explicitTransport === "http") {
    return explicitTransport;
  }

  if (explicitTransport !== undefined) {
    throw new Error(`Server "${config.name}" transport must be "stdio" or "http" when provided.`);
  }

  const hasCommand = hasNonEmptyStringField(config.definition, "command");
  const hasUrl = hasNonEmptyStringField(config.definition, "url");

  if (hasCommand && hasUrl) {
    throw new Error(`Server "${config.name}" has both command and url; set transport explicitly or remove one of them.`);
  }

  if (hasCommand) {
    return "stdio";
  }

  if (hasUrl) {
    return "http";
  }

  throw new Error(`Server "${config.name}" must provide command or url, or set transport to "stdio" or "http".`);
}

export interface McpServerFactoryDependencies {
  readonly oauth?: UnsupportedOauthServerDependencies;
}

export function createMcpServer(
  config: ResolvedServerConfig,
  dependencies: McpServerFactoryDependencies = {},
): McpServer {
  switch (resolveTransportHint(config)) {
    case "stdio":
      rejectOauthWithStdio(config);
      return new StdioPragmaticServer(config);
    case "http":
      if (hasOauthAuthentication(config.definition, config.name)) {
        return new UnsupportedOauthServer(config, dependencies.oauth);
      }
      return hasStaticAuth(config.definition)
        ? new HttpTokenServer(config)
        : new HttpPublicServer(config);
  }
}
