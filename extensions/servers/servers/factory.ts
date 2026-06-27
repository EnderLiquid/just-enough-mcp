import type { CompatibilityProfile, ResolvedServerConfig, ServerDefinition } from "../../modeling/types.js";
import { HttpPublicServer } from "./http-public-server.js";
import { HttpTokenServer } from "./http-token-server.js";
import { StdioPragmaticServer } from "./stdio-pragmatic-server.js";
import type { McpServer } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function resolveCompatibilityProfile(config: ResolvedServerConfig): CompatibilityProfile {
  const transport = config.definition.transport;

  if (transport === "stdio") {
    return "stdio-tools-pragmatic";
  }

  if (transport === "http") {
    return hasStaticAuth(config.definition) ? "http-tools-token" : "http-tools-public";
  }

  throw new Error(`Server "${config.name}" must set transport to "stdio" or "http".`);
}

export function createMcpServer(config: ResolvedServerConfig): McpServer {
  const profile = resolveCompatibilityProfile(config);

  switch (profile) {
    case "stdio-tools-pragmatic":
      return new StdioPragmaticServer(config);
    case "http-tools-public":
      return new HttpPublicServer(config);
    case "http-tools-token":
      return new HttpTokenServer(config);
    default: {
      const exhaustiveCheck: never = profile;
      throw new Error(`Unsupported compatibility profile: ${exhaustiveCheck}`);
    }
  }
}
