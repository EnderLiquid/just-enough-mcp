import {
  type PluginConfigLoadResult,
  type ResolvedServerConfig,
  type ServerOverview,
} from "../modeling/types.js";

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function ensureOverviewHeading(overview: ServerOverview): string {
  if (overview.content.startsWith("#")) {
    return overview.content;
  }

  return `# ${overview.name}\n\n${overview.content}`;
}

function formatOverviewBlock(server: ResolvedServerConfig): string {
  const lines: string[] = [];

  if (server.overview.path) {
    lines.push(`> Overview file: ${normalizePathSlashes(server.overview.path)}`, "");
  }

  lines.push(ensureOverviewHeading(server.overview));
  return lines.join("\n");
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
    "- Non-text or large tool results are materialized to local files.",
    "",
    "Connection behavior:",
    "- Inspecting a server catalog or calling a server tool connects to that server automatically when needed.",
    "",
    "Overviews:",
    "- Traditional MCP integrations often connect to all MCP servers at session start and expose all of their registered tools immediately, resulting in slow startup and significant initial consumption of context windows",
    "- The `Just Enough MCP` plugin, however, recognizes that: a single MCP server is usually atomic, though the tools inside the same server are often tightly coupled.",
    "- This plugin therefore takes a different approach: uses server overviews as the initial discovery layer so MCP context can be lazily connected and progressively disclosed at the server level.",
    "- In this session, only those server overviews are injected below as part of the initial system prompt.",
    "- Full tool lists, tool descriptions, and parameter schemas are intentionally omitted at first and must be fetched on demand after you identify the server relevant to the current task.",
    "",
    "Overview maintenance:",
    "- Each overview is a local markdown file.",
    `- By default, overviews live under \`${normalizePathSlashes(config.overviewDir)}\` as \`<serverName>.md\`.`,
    `- The plugin config file is \`${normalizePathSlashes(config.configPath)}\`; a server may also use an explicit overview path configured there.`,
    "- The injected server list below includes each resolved overview path when available, so you can locate and maintain the corresponding file directly.",
    "- When the plugin first connects to a server successfully, it can read the server metadata exposed by the MCP client after the handshake. That metadata often includes a `description` field returned by the server itself.",
    "- If the server does not already have an overview file and no explicit overview path is configured, the plugin may use that `description` as the starting point for a minimal overview draft in this form:",
    "```md",
    "# <serverName>",
    "",
    "<description>",
    "```",
    "- That `description` is only coarse server metadata. It is usually not rich enough for reliable task routing, suitability judgments, or misuse-boundary judgments on its own.",
    "- If an overview is missing, obviously outdated, or too thin to support reliable server selection, help the user improve it.",
    "- Before creating, rewriting, organizing, or reviewing an MCP server overview, load the `mcp-overview-writer` skill.",
    "- Changes to config or overview files appear in the injected prompt only after reload; ask the user to run `/reload` when needed.",
    "",
    "Workflow:",
    "1. Read the server overviews below.",
    "2. Choose one relevant server.",
    "3. Call `mcp({ server: \"<name>\" })` to inspect that server's full tool catalog.",
    "4. Call `mcp({ server: \"<name>\", tool: \"<tool>\", args: \"<json>\" })` to use a tool.",
    "5. Use `mcp({ connect: \"<name>\" })` only when an explicit connection step is useful.",
    "",
    "Available MCP servers:",
  ];

  if (config.servers.length === 0) {
    lines.push("- (none configured)");
  } else {
    for (const server of config.servers) {
      lines.push("", formatOverviewBlock(server));
    }
  }

  return lines.join("\n");
}
