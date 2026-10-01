import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "./schema.js";
import { materializeToolCallResult, type MaterializeCallToolResultInput } from "../../core/artifacts/materializer.js";
import type { MaterializationSettings, StoredPayloadItem } from "../../core/artifacts/types.js";
import type { TuiResultRenderSettings } from "../rendering/types.js";
import type { McpToolResultDetails, McpToolStructuredContent, McpToolStructuredPayloadItem } from "./types.js";
import type { ServerCatalogResult } from "../../core/modeling/types.js";
import { createMcpResultRenderer } from "../rendering/result-renderer.js";
import type { McpRegistry, McpRegistryStatus } from "../../core/servers/registry.js";
import { pluralize } from "../../core/formatting/english.js";

export const mcpToolArgumentsSchema = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  properties: {},
  additionalProperties: true,
  description: [
    "Arguments for the selected MCP tool.",
    "Follow the input schema returned by the preceding list action.",
    "Omit this field when the selected tool takes no arguments.",
  ].join(" "),
});

export const mcpToolParametersSchema = Type.Object({
  action: StringEnum(["list", "call"] as const, {
    description: "List one server's complete tool catalog or call one listed tool",
  }),
  server: Type.String({ description: "MCP server name" }),
  tool: Type.Optional(Type.String({ description: "Tool name; required for the call action" })),
  args: Type.Optional(mcpToolArgumentsSchema),
});

export const mcpToolOutputSchema = Type.Unsafe({
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["catalog", "call"],
    },
    server: { type: "string" },
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    tool: { type: "string" },
    payloadItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          source: { type: "string" },
          contentType: { type: "string" },
          mimeType: { type: "string" },
          rawMimeType: { type: "string" },
          uri: { type: "string" },
          description: { type: "string" },
          text: { type: "string" },
          binaryBase64: { type: "string" },
          parsedJson: {},
          path: { type: "string" },
          fileName: { type: "string" },
        },
        required: ["index", "source", "mimeType", "path", "fileName"],
        additionalProperties: false,
      },
    },
    manifestPath: { type: "string" },
    isError: { type: "boolean" },
  },
  required: ["kind", "server"],
  additionalProperties: false,
});

function toStructuredPayloadItem(item: StoredPayloadItem): McpToolStructuredPayloadItem {
  const { preview: _preview, ...structuredItem } = item;
  return structuredItem;
}

function asStructuredContent(value: McpToolStructuredContent): JsonValue {
  return value as unknown as JsonValue;
}

export interface McpToolRuntime {
  getRegistry(): McpRegistry | undefined;
  getArtifactDir(): string;
  getMaterializationSettings(): Partial<MaterializationSettings> | undefined;
  getTuiSettings(): TuiResultRenderSettings | undefined;
  refreshFooterStatus: (
    status?: McpRegistryStatus,
  ) => void | Promise<void>;
}

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
      // 某些 provider 会将可选字段序列化为空白占位符("" 或 {})；此处将其视为已省略
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

function requireRegistry(runtime: McpToolRuntime): McpRegistry {
  const registry = runtime.getRegistry();
  if (!registry) {
    throw new Error("just-enough-mcp is not initialized for the current session");
  }
  return registry;
}

export function createMcpTool(runtime: McpToolRuntime) {
  const renderer = createMcpResultRenderer(runtime.getTuiSettings);
  return defineTool<typeof mcpToolParametersSchema, McpToolResultDetails>({
    name: "mcp_tool",
    label: "MCP Tool",
    description: [
      "List a selected MCP server's complete tool catalog or call a tool from that catalog.",
      "Both actions initialize the selected server automatically when needed.",
      "For call, pass the selected tool's native object input from list and omit args for a zero-argument tool.",
    ].join(" "),
    promptSnippet: "List a selected MCP server's complete tool catalog, then call a listed tool with native object arguments.",
    renderCall: (args, theme, context) => renderer.renderMcpToolCall(args, theme, context),
    renderResult: (result, options, theme, context) => renderer.renderMcpToolResult(result, options, theme, context),
    parameters: mcpToolParametersSchema,
    outputSchema: mcpToolOutputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      validateInvocation(params);
      const registry = requireRegistry(runtime);

      if (params.action === "list") {
        try {
          const catalog = await registry.getServerCatalog(params.server, signal);
          const structuredContent: McpToolStructuredContent = {
            kind: "catalog",
            server: catalog.server.name,
            tools: catalog.tools,
          };
          return {
            content: [{
              type: "text",
              text: formatCatalogResult(catalog),
            }],
            structuredContent: asStructuredContent(structuredContent),
            details: {
              kind: "list",
              toolCount: catalog.tools.length,
            },
          };
        } finally {
          await runtime.refreshFooterStatus(await registry.getStatus());
        }
      }

      try {
        const args = params.args ?? {};
        const execution = await registry.callTool(params.server, params.tool!, args, signal);
        const materialized = materializeMcpToolResult({
          artifactDir: runtime.getArtifactDir(),
          server: execution.server.name,
          tool: execution.toolName,
          result: execution.result,
          settings: runtime.getMaterializationSettings(),
        });
        const isError = execution.result.isError === true;
        const structuredContent: McpToolStructuredContent = {
          kind: "call",
          server: execution.server.name,
          tool: execution.toolName,
          payloadItems: materialized.payloadItems.map(toStructuredPayloadItem),
          manifestPath: materialized.manifestPath,
          isError,
        };
        return {
          content: [{
            type: "text",
            text: materialized.summaryText,
          }],
          structuredContent: asStructuredContent(structuredContent),
          ...(isError ? { isError: true } : {}),
          details: {
            kind: "call",
            payloadItemCount: materialized.payloadItems.length,
            outcome: isError ? "error" : "success",
          },
        };
      } finally {
        await runtime.refreshFooterStatus(await registry.getStatus());
      }
    },
  });
}

export function registerMcpTool(
  pi: ExtensionAPI,
  runtime: McpToolRuntime,
): ReturnType<typeof createMcpTool> {
  const tool = createMcpTool(runtime);
  pi.registerTool(tool);
  pi.on("tool_result", (event) => {
    if (event.toolName !== tool.name) {
      return;
    }

    const details = event.details as McpToolResultDetails | undefined;
    if (details?.kind === "call" && details.outcome === "error") {
      return { isError: true };
    }
  });
  return tool;
}
