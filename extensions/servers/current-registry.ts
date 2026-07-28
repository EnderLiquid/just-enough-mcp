import type { ServerRegistry } from "./registry.js";

let currentServerRegistry: ServerRegistry | undefined;

export function getCurrentServerRegistry(): ServerRegistry | undefined {
  return currentServerRegistry;
}

export function requireCurrentServerRegistry(): ServerRegistry {
  if (!currentServerRegistry) {
    throw new Error("just-enough-mcp is not initialized for the current session.");
  }
  return currentServerRegistry;
}

export function installCurrentServerRegistry(registry: ServerRegistry): () => void {
  currentServerRegistry = registry;

  return () => {
    if (currentServerRegistry === registry) {
      currentServerRegistry = undefined;
    }
  };
}
