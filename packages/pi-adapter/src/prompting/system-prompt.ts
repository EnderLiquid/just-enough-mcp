import type { PluginConfigLoadResult } from "../config/types.js";
import {
  type ResolvedServerConfig,
  type ServerOverview,
} from "@enderliquid/just-enough-mcp";

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

export interface ServerOverviewPromptOptions {
  /** codemode 启用时，注入在脚本中使用 mcp_tool 的探测提示。 */
  codemodeEnabled?: boolean;
}

export function createServerOverviewPrompt(
  config: PluginConfigLoadResult,
  options: ServerOverviewPromptOptions = {},
): string {
  // 中文维护基准见 ./system-prompt.zh-CN.md；该文件不会注入模型。
  // 修改英文运行时文案时，保持两个文件的章节顺序与语义同步。

  const lines = [
    "MCP server access in this session is provided by the Just Enough MCP plugin, not by Pi natively. The plugin intentionally supports only MCP's Tools primitive.",
    "MCP integration model:",
    "- Tools provided by an MCP server are not registered as separate, directly callable Pi tools.",
    "- Use `mcp_server` to inspect server state, control server lifecycle, and manage OAuth; use `mcp_tool` to read one server's tool catalog and relay calls to the tools listed in it.",
    "Result materialization:",
    "- An MCP tool call may include one or more items, each materialized as a separate local file.",
    "- Long text item previews are truncated and include a path to their full materialized content. Paths to materialized files for non-text items are also provided. Use those files as needed.",
    ...(options.codemodeEnabled
      ? [
          "Codemode:",
          "- Before calling `mcp_tool` from a codemode script, run a script that returns its generated declaration, for example `return await describeTool(\"mcp_tool\")`, and read the result shape from it.",
          "- `searchTools()` and `describeNamespace()` exist for codemode's integration with Pi's native MCP support; this plugin implements MCP differently, so they have no effect in this session.",
        ]
      : []),
    "Overviews:",
    "- An overview is a server-discovery layer independent of the MCP protocol, maintained by users and agents to enable lazy server connection and progressive context disclosure.",
    "- An overview clarifies a server's functional boundaries and covers implicit usage constraints that the server's tool catalog does not make clear.",
    "- Initially, only each server's overview is injected into your system prompt. During the session, use the overview to decide whether a server is relevant; once you decide to use it, retrieve its complete tool catalog.",
    "Overview maintenance:",
    "- Each overview is a local Markdown file. Its path is injected into the context along with its content so you can locate and maintain the file directly.",
    "- If an overview is missing, incomplete, or clearly stale, help the user improve it. An overview may be generated automatically from metadata in a server initialization response; its presence does not mean it is complete.",
    "- Before creating, modifying, or reviewing an overview, read the `mcp-overview-writer` skill.",
    "- Changes to plugin config or overview files take effect only after a reload; ask the user to run `/reload` when needed.",
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
