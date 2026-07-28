import type { PluginConfigLoadResult } from "../modeling/types.js";

let currentPluginConfig: PluginConfigLoadResult | undefined;

export function getCurrentPluginConfig(): PluginConfigLoadResult | undefined {
  return currentPluginConfig;
}

export function requireCurrentPluginConfig(): PluginConfigLoadResult {
  if (!currentPluginConfig) {
    throw new Error("just-enough-mcp is not initialized for the current session.");
  }
  return currentPluginConfig;
}

export function installCurrentPluginConfig(config: PluginConfigLoadResult): () => void {
  currentPluginConfig = config;

  return () => {
    if (currentPluginConfig === config) {
      currentPluginConfig = undefined;
    }
  };
}
