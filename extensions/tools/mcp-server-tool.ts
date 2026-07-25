import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerResultDetails } from "../modeling/types.js";
import { renderMcpServerCall, renderMcpServerResult } from "../rendering/result-renderer.js";
import type { ServerRegistryStatus } from "../servers/registry.js";
import { getMcpRuntime } from "../servers/runtime.js";
import { pluralize } from "../formatting/english.js";

export const mcpServerParametersSchema = Type.Object({
  action: StringEnum(["status", "connect", "disconnect"] as const, {
    description: "Inspect configured MCP server state or change one server's availability",
  }),
  server: Type.Optional(Type.String({
    description: "Optional server name for status; required for connect and disconnect",
  })),
});

function requireServer(params: { action: string; server?: string }): string {
  if (params.server === undefined || !params.server.trim()) {
    throw new Error(`Invalid mcp_server invocation: action "${params.action}" requires a non-empty server.`);
  }
  return params.server;
}

function rejectUnknownFields(params: object): void {
  const unknown = Object.keys(params).filter(key => key !== "action" && key !== "server");
  if (unknown.length > 0) {
    throw new Error(`Invalid mcp_server invocation: unknown ${pluralize(unknown.length, "field")} ${unknown.join(", ")}.`);
  }
}

function validateInvocation(params: {
  action: "status" | "connect" | "disconnect";
  server?: string;
}): void {
  rejectUnknownFields(params);
  switch (params.action) {
    case "status":
      if (params.server !== undefined) {
        requireServer(params);
      }
      return;
    case "connect":
    case "disconnect":
      requireServer(params);
      return;
    default: {
      const unreachable: never = params.action;
      throw new Error(`Invalid mcp_server action: ${String(unreachable)}`);
    }
  }
}

function formatServerStatus(status: ServerRegistryStatus): string {
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

export const mcpServerTool = defineTool<typeof mcpServerParametersSchema, McpServerResultDetails>({
  name: "mcp_server",
  label: "MCP Server",
  description: [
    "Inspect and manage configured MCP server state.",
    "Do not connect routinely before using mcp_tool; mcp_tool list and call initialize servers automatically.",
  ].join(" "),
  promptSnippet: "Inspect configured MCP server status, or explicitly connect or disconnect one server when needed.",
  renderCall: (args, theme, context) => renderMcpServerCall(args, theme, context),
  renderResult: (result, options, theme, context) => renderMcpServerResult(result, options, theme, context),
  parameters: mcpServerParametersSchema,
  async execute(_toolCallId, params, signal) {
    validateInvocation(params);
    const runtime = getMcpRuntime();

    if (params.action === "status") {
      try {
        if (params.server !== undefined) {
          const server = runtime.registry().getServerState(params.server);
          if (!server) {
            throw new Error(`Unknown MCP server: ${params.server}`);
          }
          return {
            content: [{ type: "text", text: `${server.name}\n${server.connectState}` }],
            details: { kind: "status", serverName: server.name, connectState: server.connectState },
          };
        }

        const status = runtime.getStatus();
        return {
          content: [{ type: "text", text: formatServerStatus(status) }],
          details: {
            kind: "status",
            connectedCount: status.connectedCount,
            totalCount: status.totalCount,
          },
        };
      } finally {
        runtime.refreshFooter();
      }
    }

    if (params.action === "connect") {
      try {
        await runtime.registry().connectServer(params.server!, signal);
      } finally {
        runtime.refreshFooter();
      }
      return {
        content: [{ type: "text", text: "Connected" }],
        details: { kind: "connect" },
      };
    }

    try {
      await runtime.registry().disconnectServer(params.server!);
    } finally {
      runtime.refreshFooter();
    }
    return {
      content: [{ type: "text", text: "Disconnected" }],
      details: { kind: "disconnect" },
    };
  },
});

export function registerMcpServerTool(pi: ExtensionAPI): void {
  pi.registerTool(mcpServerTool);
}
