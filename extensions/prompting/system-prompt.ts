import {
  type PluginConfigLoadResult,
  type ResolvedServerConfig,
  type ServerOverview,
} from "../modeling/types.js";

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function ensureOverviewHeading(overview: ServerOverview): string {
  if (/^(?:[ \t]*\r?\n)* {0,3}#/.test(overview.content)) {
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
  // 中文维护基准见 ./system-prompt.zh-CN.md；该文件不会注入模型。
  // 修改英文运行时文案时，保持两个文件的章节顺序与语义同步。

  const lines = [
    "Reality:",
    "MCP (Model Context Protocol) is a standard for connecting agents to external systems.",
    "The protocol was designed early in the development of agents. Some of its features now appear redundant or overly intrusive to the orchestration layer of agent applications.",
    "In current community practice, MCP's Tools primitive is widely used as a cross-agent layer for registering and calling external tools; the other primitives are used much less widely.",
    "MCP server access in this session is provided by the Just Enough MCP plugin, not by Pi natively. The plugin intentionally supports only MCP's Tools primitive; the absence of Resources, Prompts, Sampling, Elicitation, and other primitives does not define MCP's own boundary.",
    "MCP integration model:",
    "- This plugin does not register every remote MCP tool as a separate, directly callable Pi tool, and it does not create tool names of the form `mcp__<server>__<tool>`.",
    "- MCP is accessed through two Pi tools: `mcp_server` inspects server state, controls server lifecycle, and manages OAuth; `mcp_tool` reads one server's tool catalog and relays calls to the listed remote tools.",
    "- `mcp_tool` is the relay entry point: first call `mcp_tool({ action: \"list\", server: \"<name>\" })`, then call `mcp_tool({ action: \"call\", server: \"<name>\", tool: \"<listed-tool>\", args: { ... } })` according to the returned tool schema. `mcp_tool` forwards `args` to the selected server tool. The `tool` parameter must come from the catalog returned by `list`; do not guess tool names or look for directly callable Pi tools such as `mcp__<server>__<tool>`.",
    "Result materialization:",
    "- An MCP tool call may include one or more items, each materialized as a separate local file.",
    "- Long text item previews are truncated and include a path to their full materialized content. Paths to materialized files for non-text items are also provided. Use those files as needed.",
    "Overviews:",
    "- Traditional MCP integrations usually connect to every MCP server at session start and immediately register every tool from every server as a native LLM tool. This both slows agent application startup and can fill the context window immediately with many low-frequency tool definitions.",
    "- Just Enough MCP takes a different approach: users and agents maintain an additional overview for each MCP server. An overview is a server-discovery layer independent of the MCP protocol, designed to enable lazy server connection and progressive context disclosure.",
    "- More specifically, an overview clarifies a server's functional boundaries. For example, one server may provide computer-use capabilities through several interdependent tools.",
    "- Initially, only each server's overview is injected into your system prompt. During the session, first use the overview to decide whether a server is relevant; after deciding to use it, retrieve its complete tool catalog. This reduces the initial context burden.",
    "- An overview can also explain implicit usage constraints that are not clear from the server's tool catalog.",
    "Overview maintenance:",
    "- Each overview is a local Markdown file.",
    "- When an overview is available, its local file path appears before the injected content so you can locate and maintain the file directly.",
    "- If an overview is missing, incomplete, or clearly stale, help the user improve it. An overview may be automatically generated from a server initialization response's metadata description; its presence does not mean it is complete.",
    "- Before creating, modifying, or reviewing an overview, read the `mcp-overview-writer` skill.",
    "- Changes to plugin config or overview files take effect only after reload; ask the user to run `/reload` when needed.",
    "Workflow:",
    "1. Use the injected overviews below to select servers on demand. Current user intent and global safety constraints take precedence over an overview if they conflict.",
    "2. Call `mcp_tool` with action `list` to read the selected server's complete tool catalog, including each tool's description and schema.",
    "3. Based on the listed tool schemas and any supplementary overview guidance, call `mcp_tool` with action `call` as a relay to use the MCP server's tools. Tool call results may include paths to materialized files for individual items; read or use those files as needed.",
    "4. Call `mcp_server` when you need to inspect server status or must explicitly control server lifecycle. `mcp_tool` actions `list` and `call` initialize the selected server automatically, so you normally do not need to call `connect` first.",
    "5. If a tool call reports that OAuth authorization is required, call `mcp_server` with action `authorize` after obtaining the user's consent or when the user has explicitly asked to access that server. It opens the user's browser and waits for the user's authorization flow to finish. After authorization succeeds, retry the operation that failed because of authorization.",
    "6. When the user asks to remove local OAuth credentials, call `mcp_server` with action `logout`.",
    "Available MCP servers and overviews, if any:",
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
