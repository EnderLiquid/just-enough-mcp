import type { CompatibilityProfileId, ConfiguredServerConfig, ResolvedServerSpec } from "../../modeling/types.js";

export function resolveInitialProfileId(config: ConfiguredServerConfig | ResolvedServerSpec): CompatibilityProfileId {
  if (config.transport === "stdio") {
    return "stdio-tools-pragmatic";
  }

  if (config.bearerToken || (config.headers && Object.keys(config.headers).length > 0)) {
    return "http-tools-token";
  }

  return "http-tools-public";
}
