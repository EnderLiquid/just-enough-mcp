import {
  type PluginConfigLoadResult,
  type ServerOverview,
} from "../modeling/types.js";

function formatOverviewBlock(overview: ServerOverview): string {
  const body = overview.content
    .split("\n")
    .map(line => `  ${line}`);

  return [`- ${overview.name}`, ...body].join("\n");
}

export function createServerOverviewPrompt(config: PluginConfigLoadResult): string {
  const lines = [
    "Reality:",
    "MCP (Model Context Protocol) is a standard for connecting AI applications to external systems.",
    "However, the protocol was designed before agent workflows had fully converged. As a result, the protocol surface takes on responsibilities that in practice belong partly to the agent layer.",
    "In current community practice, MCP is used mostly as a cross-agent external tool registration and invocation layer, rather than as a fully realized common runtime for every protocol primitive.",
    "In this Pi session, MCP is not a native built-in capability. It is provided by the Just Enough MCP plugin through a single `mcp` tool.",
    "This plugin intentionally implements only the practical path that is broadly useful today: connecting to named MCP servers, inspecting one server's full tool catalog, and calling tools on that server.",
    "Other parts of the MCP protocol are not supported in this plugin. Their absence here reflects this plugin's scope and product positioning, not the formal boundary of the MCP specification itself.",
    "",
    "Scope:",
    "- Tools only.",
    "- Not supported here: Resources, Prompts, Sampling, Elicitation.",
    "- Large tool results may be materialized to local files.",
    "",
    "Workflow:",
    "1. Read the server overviews below.",
    "2. Choose one relevant server.",
    "3. Call `mcp({ server: \"<name>\" })` to inspect that server's full tool catalog.",
    "4. Call `mcp({ server: \"<name>\", tool: \"<tool>\", args: \"<json>\" })` to use a tool.",
    "5. Use `mcp({ connect: \"<name>\" })` only when an explicit connection step is useful.",
    "6. If the config or overviews seem stale, ask the user to run `/reload`.",
    "",
    "Available MCP servers:",
  ];

  if (config.servers.length === 0) {
    lines.push("- (none configured)");
  } else {
    for (const server of config.servers) {
      lines.push(formatOverviewBlock(server.overview));
    }
  }

  return lines.join("\n");
}
