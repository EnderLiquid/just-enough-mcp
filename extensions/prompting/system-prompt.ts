import {
  DEFAULT_RUNTIME_CAPABILITIES,
  type PluginConfigLoadResult,
  type ServerOverview,
} from "../modeling/types.js";

function formatCapabilityLine(): string {
  const capabilities = [
    `Tools=${DEFAULT_RUNTIME_CAPABILITIES.supportsTools ? "yes" : "no"}`,
    `Resources=${DEFAULT_RUNTIME_CAPABILITIES.supportsResources ? "yes" : "no"}`,
    `Prompts=${DEFAULT_RUNTIME_CAPABILITIES.supportsPrompts ? "yes" : "no"}`,
    `Sampling=${DEFAULT_RUNTIME_CAPABILITIES.supportsSampling ? "yes" : "no"}`,
    `Elicitation=${DEFAULT_RUNTIME_CAPABILITIES.supportsElicitation ? "yes" : "no"}`,
  ];

  return `Current support: ${capabilities.join(", ")}.`;
}

function formatOverviewLine(overview: ServerOverview): string {
  const details = [`transport=${overview.transport}`];
  if (overview.source !== "none") {
    details.push(`overview=${overview.source}`);
  }

  return `- ${overview.name}: ${overview.summary} (${details.join(", ")})`;
}

export function createServerOverviewPrompt(config: PluginConfigLoadResult): string {
  const lines = [
    "MCP is a server-based protocol for tools and other context primitives, recently supported in Pi by Just Enough MCP plugin.",
    "This plugin intentionally preserves MCP concepts instead of flattening everything into pseudo-tools.",
    formatCapabilityLine(),
    "Recommended workflow: inspect server overviews, choose one server, fetch that server's full tool catalog, then call tools as needed.",
    "Available MCP servers:",
  ];

  if (config.servers.length === 0) {
    lines.push("- (none configured)");
  } else {
    for (const server of config.servers) {
      lines.push(formatOverviewLine(server.overview));
    }
  }

  return lines.join("\n");
}
