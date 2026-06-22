import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeToolCallResult } from "../artifacts/materializer.js";
import { getMcpRuntime } from "../clients/runtime.js";
import type { McpToolResultDetails } from "../modeling/types.js";
import { renderMcpToolCall, renderMcpToolResult } from "../rendering/result-renderer.js";

const parametersSchema = Type.Object({
  connect: Type.Optional(Type.String({ description: "Server name to connect" })),
  server: Type.Optional(Type.String({ description: "Server name whose full tool catalog should be returned" })),
  tool: Type.Optional(Type.String({ description: "Tool name to call" })),
  args: Type.Optional(Type.String({ description: "Arguments as JSON string" })),
});

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseArgs(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  const parsed: unknown = JSON.parse(input);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("mcp args must be a JSON object string.");
  }
  return parsed as Record<string, unknown>;
}

const mcpTool = defineTool<typeof parametersSchema, McpToolResultDetails>({
  name: "mcp",
  label: "MCP",
  description: "Minimal MCP runtime entry point for server-level progressive disclosure.",
  promptSnippet: "Inspect MCP servers, connect to one server, read that server's full tool catalog, then call tools.",
  renderCall: (args, theme) => renderMcpToolCall(args, theme),
  renderResult: (result, options, theme) => renderMcpToolResult(result, options, theme),
  parameters: parametersSchema,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const runtime = getMcpRuntime();

    if (!params.connect && !params.server && !params.tool) {
      const status = runtime.getStatus();
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: [
            "just-enough-mcp status",
            `connected servers: ${status.connectedCount}/${status.totalCount}`,
            ...status.servers.map(server => {
              const suffix = server.error ? ` (${server.error})` : "";
              return `- ${server.config.name}: ${server.status}${suffix}`;
            }),
          ].join("\n"),
        }],
        details: {
          stage: "runtime-status",
          servers: status.servers.map(server => ({
            name: server.config.name,
            transport: server.config.transport,
            connectionMode: server.config.connectionMode,
            status: server.status,
            overviewSource: server.config.overview.source,
            error: server.error,
          })),
        },
      };
    }

    if (params.connect) {
      const server = await runtime.registry().connectServer(params.connect);
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: server.status === "connected"
            ? `Connected MCP server: ${server.config.name}`
            : `Failed to connect MCP server: ${server.config.name}\n${server.error ?? "Unknown error"}`,
        }],
        details: {
          stage: "runtime-connect",
          servers: [{
            name: server.config.name,
            transport: server.config.transport,
            connectionMode: server.config.connectionMode,
            status: server.status,
            overviewSource: server.config.overview.source,
            error: server.error,
          }],
        },
        isError: server.status !== "connected",
      };
    }

    if (params.server && !params.tool) {
      const catalog = await runtime.registry().getServerCatalog(params.server);
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: [
            `MCP tool catalog for ${catalog.server.config.name}`,
            ...catalog.tools.map(tool => stringifyJson({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: tool.annotations,
              execution: tool.execution,
            })),
          ].join("\n\n"),
        }],
        details: {
          stage: "runtime-tools-list",
          servers: [{
            name: catalog.server.config.name,
            transport: catalog.server.config.transport,
            connectionMode: catalog.server.config.connectionMode,
            status: catalog.server.status,
            overviewSource: catalog.server.config.overview.source,
            error: catalog.server.error,
          }],
        },
      };
    }

    if (params.server && params.tool) {
      const parsedArgs = parseArgs(params.args);
      const execution = await runtime.registry().callTool(params.server, params.tool, parsedArgs);
      const materialized = materializeToolCallResult({
        cwd: ctx.cwd,
        server: execution.server.config.name,
        tool: execution.toolName,
        result: execution.result,
      });
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: materialized.summaryText,
        }],
        details: {
          stage: "runtime-call-tool",
          materialized: true,
          callDir: materialized.callDir,
          manifestPath: materialized.manifestPath,
          payloadItems: materialized.payloadItems,
          mainFiles: materialized.mainFiles,
          metaFiles: materialized.metaFiles,
          servers: [{
            name: execution.server.config.name,
            transport: execution.server.config.transport,
            connectionMode: execution.server.config.connectionMode,
            status: execution.server.status,
            overviewSource: execution.server.config.overview.source,
            error: execution.server.error,
          }],
        },
        isError: execution.result.isError === true,
      };
    }

    return {
      content: [{
        type: "text",
        text: "Invalid mcp invocation. Use status, connect, server, or server+tool.",
      }],
      details: {
        stage: "runtime-invalid-input",
        servers: [],
      },
      isError: true,
    };
  },
});

export function registerMcpTool(pi: ExtensionAPI): void {
  pi.registerTool(mcpTool);
}
