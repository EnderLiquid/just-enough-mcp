import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeToolCallResult } from "../artifacts/materializer.js";
import { getMcpRuntime } from "../servers/runtime.js";
import type { McpToolResultDetails, ServerCatalogResult } from "../modeling/types.js";
import type { ServerRegistryStatus } from "../servers/registry.js";
import { renderMcpToolCall, renderMcpToolResult } from "../rendering/result-renderer.js";
import { pluralize } from "../formatting/english.js";

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

function formatStatusResult(status: ServerRegistryStatus): string {
  const header = `${status.connectedCount}/${status.totalCount} ${pluralize(status.totalCount, "server")} connected:`;
  if (status.servers.length === 0) {
    return header;
  }

  return [
    header,
    ...status.servers.map((server, index) => [
      `[${index + 1}] ${server.name}`,
      server.connectState,
    ].join("\n")),
  ].join("\n\n");
}

function formatConnectResult(): string {
  return "Connected";
}

function formatCatalogResult(catalog: ServerCatalogResult): string {
  const sections = catalog.tools.map((tool, index) => [
    `[${index + 1}] ${tool.name}`,
    stringifyJson({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      execution: tool.execution,
    }),
  ].join("\n"));

  return [`${catalog.tools.length} ${pluralize(catalog.tools.length, "tool")} available:`, ...sections].join("\n\n");
}

export const mcpTool = defineTool<typeof parametersSchema, McpToolResultDetails>({
  name: "mcp",
  label: "MCP",
  description: "Minimal MCP runtime entry point for server-level progressive disclosure.",
  promptSnippet: "Inspect MCP servers, connect to one server, read that server's full tool catalog, then call tools.",
  renderCall: (args, theme, context) => renderMcpToolCall(args, theme, context),
  renderResult: (result, options, theme, context) => renderMcpToolResult(result, options, theme, context),
  parameters: parametersSchema,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const runtime = getMcpRuntime();

    if (!params.connect && !params.server && !params.tool) {
      const status = runtime.getStatus();
      runtime.refreshFooter();
      return {
        content: [{
          type: "text",
          text: formatStatusResult(status),
        }],
        details: {
          kind: "status",
          connectedCount: status.connectedCount,
          totalCount: status.totalCount,
        },
      };
    }

    if (params.connect) {
      try {
        await runtime.registry().connectServer(params.connect, signal);
      } finally {
        runtime.refreshFooter();
      }

      return {
        content: [{
          type: "text",
          text: formatConnectResult(),
        }],
        details: { kind: "connect" },
      };
    }

    if (params.server && !params.tool) {
      try {
        const catalog = await runtime.registry().getServerCatalog(params.server, signal);
        return {
          content: [{
            type: "text",
            text: formatCatalogResult(catalog),
          }],
          details: {
            kind: "catalog",
            toolCount: catalog.tools.length,
          },
        };
      } finally {
        runtime.refreshFooter();
      }
    }

    if (params.server && params.tool) {
      try {
        const parsedArgs = parseArgs(params.args);
        const execution = await runtime.registry().callTool(params.server, params.tool, parsedArgs, signal);
        const materialized = materializeToolCallResult({
          cwd: ctx.cwd,
          server: execution.server.name,
          tool: execution.toolName,
          result: execution.result,
          settings: runtime.config()?.materialization,
        });
        return {
          content: [{
            type: "text",
            text: materialized.summaryText,
          }],
          details: {
            kind: "call",
            payloadItemCount: materialized.payloadItems.length,
            outcome: execution.result.isError === true ? "error" : "success",
          },
        };
      } finally {
        runtime.refreshFooter();
      }
    }

    throw new Error("Invalid mcp invocation. Use status, connect, server, or server+tool.");
  },
});

export function registerMcpTool(pi: ExtensionAPI): void {
  pi.registerTool(mcpTool);
  pi.on("tool_result", (event) => {
    if (event.toolName !== mcpTool.name) {
      return;
    }

    const details = event.details as McpToolResultDetails | undefined;
    if (details?.kind === "call" && details.outcome === "error") {
      return { isError: true };
    }
  });
}
