import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeToolCallResult, type MaterializeCallToolResultInput } from "../artifacts/materializer.js";
import type { McpToolResultDetails, ServerCatalogResult } from "../modeling/types.js";
import { renderMcpToolCall, renderMcpToolResult } from "../rendering/result-renderer.js";
import { getMcpRuntime } from "../servers/runtime.js";
import { pluralize } from "../formatting/english.js";

export const mcpToolArgumentsSchema = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  properties: {},
  description: [
    "Arguments for the selected MCP tool.",
    "Follow the input schema returned by the preceding list action.",
    "Omit this field when the selected tool takes no arguments.",
  ].join(" "),
});

export const mcpToolParametersSchema = Type.Object({
  action: StringEnum(["list", "call"] as const, {
    description: "List available tools on one MCP server or call one of them",
  }),
  server: Type.String({ description: "MCP server name" }),
  tool: Type.Optional(Type.String({ description: "Tool name; required for the call action" })),
  args: Type.Optional(mcpToolArgumentsSchema),
});

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`mcp_tool ${field} must be a non-empty string.`);
  }
}

function rejectUnknownFields(params: object, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Invalid mcp_tool invocation: unknown ${pluralize(unknown.length, "field")} ${unknown.join(", ")}.`);
  }
}

function isEmptyObject(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length === 0;
}

function validateInvocation(params: {
  action: "list" | "call";
  server: string;
  tool?: string;
  args?: Record<string, unknown>;
}): void {
  rejectUnknownFields(params, ["action", "server", "tool", "args"]);
  requireNonEmpty(params.server, "server");
  if (params.args !== undefined && (
    typeof params.args !== "object"
    || params.args === null
    || Array.isArray(params.args)
  )) {
    throw new Error("Invalid mcp_tool invocation: args must be an object when provided.");
  }

  switch (params.action) {
    case "list":
      // Some providers serialize optional fields as empty placeholders; treat them as omitted here.
      if (
        (params.tool !== undefined && params.tool.trim().length > 0)
        || (params.args !== undefined && !isEmptyObject(params.args))
      ) {
        throw new Error('Invalid mcp_tool invocation: action "list" does not accept tool or args.');
      }
      return;
    case "call":
      if (params.tool === undefined) {
        throw new Error('Invalid mcp_tool invocation: action "call" requires tool.');
      }
      requireNonEmpty(params.tool, "tool");
      return;
    default: {
      const unreachable: never = params.action;
      throw new Error(`Invalid mcp_tool action: ${String(unreachable)}`);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function materializeMcpToolResult(input: MaterializeCallToolResultInput) {
  try {
    return materializeToolCallResult(input);
  } catch (cause) {
    throw new Error(
      `MCP server "${input.server}" returned a result for tool "${input.tool}", but local result materialization failed. ` +
      "The server-side operation may already have taken effect. " +
      "Do not retry this tool call automatically. " +
      `Cause: ${formatError(cause)}`,
      { cause },
    );
  }
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

export const mcpTool = defineTool<typeof mcpToolParametersSchema, McpToolResultDetails>({
  name: "mcp_tool",
  label: "MCP Tool",
  description: [
    "List or call tools on one MCP server.",
    "Both actions initialize the selected server automatically when needed.",
    "Use the input schema returned by list when constructing call args.",
  ].join(" "),
  promptSnippet: "List one MCP server's full tool catalog, then call a selected tool with native object arguments.",
  renderCall: (args, theme, context) => renderMcpToolCall(args, theme, context),
  renderResult: (result, options, theme, context) => renderMcpToolResult(result, options, theme, context),
  parameters: mcpToolParametersSchema,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    validateInvocation(params);
    const runtime = getMcpRuntime();

    if (params.action === "list") {
      try {
        const catalog = await runtime.registry().getServerCatalog(params.server, signal);
        return {
          content: [{
            type: "text",
            text: formatCatalogResult(catalog),
          }],
          details: {
            kind: "list",
            toolCount: catalog.tools.length,
          },
        };
      } finally {
        runtime.refreshFooter();
      }
    }

    try {
      const args = params.args ?? {};
      const execution = await runtime.registry().callTool(params.server, params.tool!, args, signal);
      const materialized = materializeMcpToolResult({
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
