import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeToolCallResult } from "../artifacts/materializer.js";
import { toMaterializationSettings } from "../artifacts/settings.js";
import { getMcpRuntime } from "../servers/runtime.js";
import type { ServerCatalogResult } from "../modeling/types.js";
import type { ServerRegistryStatus } from "../servers/registry.js";
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

function formatToolCount(count: number): string {
  return `${count} ${count === 1 ? "Tool" : "Tools"}`;
}

function formatStatusResult(status: ServerRegistryStatus): string {
  const header = `${status.connectedCount}/${status.totalCount} Connected`;
  if (status.servers.length === 0) {
    return header;
  }

  return [
    header,
    ...status.servers.map((server, index) => [
      `[${index + 1}] ${server.name}`,
      `Connect State: ${server.connectState}`,
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

  return [formatToolCount(catalog.tools.length), ...sections].join("\n\n");
}

export const mcpTool = defineTool<typeof parametersSchema, undefined>({
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
          text: formatStatusResult(status),
        }],
        details: undefined,
      };
    }

    if (params.connect) {
      try {
        await runtime.registry().connectServer(params.connect);
      } finally {
        runtime.refreshFooter(ctx);
      }

      return {
        content: [{
          type: "text",
          text: formatConnectResult(),
        }],
        details: undefined,
      };
    }

    if (params.server && !params.tool) {
      const catalog = await runtime.registry().getServerCatalog(params.server);
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: formatCatalogResult(catalog),
        }],
        details: undefined,
      };
    }

    if (params.server && params.tool) {
      const parsedArgs = parseArgs(params.args);
      const execution = await runtime.registry().callTool(params.server, params.tool, parsedArgs);
      const materialized = materializeToolCallResult({
        cwd: ctx.cwd,
        server: execution.server.name,
        tool: execution.toolName,
        result: execution.result,
        settings: toMaterializationSettings(runtime.config()?.resultPresentation),
      });
      runtime.refreshFooter(ctx);
      return {
        content: [{
          type: "text",
          text: materialized.summaryText,
        }],
        details: undefined,
        isError: execution.result.isError === true,
      };
    }

    throw new Error("Invalid mcp invocation. Use status, connect, server, or server+tool.");
  },
});

export function registerMcpTool(pi: ExtensionAPI): void {
  pi.registerTool(mcpTool);
}
