import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeToolCallResult } from "../artifacts/materializer.js";
import { getMcpRuntime } from "../servers/runtime.js";
import type { ServerSnapshot } from "../modeling/types.js";
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

function assertNever(value: never): never {
  throw new Error(`Unhandled server profile: ${value}`);
}

function formatServerSnapshot(snapshot: ServerSnapshot): string {
  const profile = snapshot.profile;
  switch (profile) {
    case "stdio-tools-pragmatic":
      return `${snapshot.name}: ${snapshot.connectState}`;
    case "http-tools-public":
    case "http-tools-token":
      return `${snapshot.name}: ${profile}`;
    default:
      return assertNever(profile);
  }
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
          text: [
            "just-enough-mcp status",
            `connected servers: ${status.connectedCount}/${status.totalCount}`,
            ...status.servers.map(server => `- ${formatServerSnapshot(server)}`),
          ].join("\n"),
        }],
        details: undefined,
      };
    }

    if (params.connect) {
      let server: ServerSnapshot;
      try {
        server = await runtime.registry().connectServer(params.connect);
      } finally {
        runtime.refreshFooter(ctx);
      }

      return {
        content: [{
          type: "text",
          text: `Connected MCP server: ${server.name}`,
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
          text: [
            `MCP tool catalog for ${catalog.server.name}`,
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
        details: undefined,
      };
    }

    if (params.server && params.tool) {
      const parsedArgs = parseArgs(params.args);
      const execution = await runtime.registry().callTool(params.server, params.tool, parsedArgs);
      const resultPresentation = runtime.config()?.resultPresentation;
      const { collapsedPreviewLines: _collapsedPreviewLines, ...materializationSettings } = resultPresentation ?? {};
      const materialized = materializeToolCallResult({
        cwd: ctx.cwd,
        server: execution.server.name,
        tool: execution.toolName,
        result: execution.result,
        settings: materializationSettings,
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
