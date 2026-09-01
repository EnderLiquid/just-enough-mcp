import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerResultDetails } from "../modeling/types.js";
import { refreshFooterStatus } from "../rendering/footer-status.js";
import { renderMcpServerCall, renderMcpServerResult } from "../rendering/result-renderer.js";
import { requireCurrentServerRegistry } from "../servers/current-registry.js";
import type { ServerRegistryStatus } from "../servers/registry.js";
import { pluralize } from "../formatting/english.js";

export const mcpServerParametersSchema = Type.Object({
  action: StringEnum(["status", "connect", "disconnect", "authorize", "logout"] as const, {
    description: "Inspect configured MCP server state, change availability, or control OAuth authorization",
  }),
  server: Type.Optional(Type.String({
    description: "Optional server name for status; required for connect, disconnect, authorize, and logout",
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
  action: "status" | "connect" | "disconnect" | "authorize" | "logout";
  server?: string;
}): string | undefined {
  rejectUnknownFields(params);
  switch (params.action) {
    case "status":
      return params.server?.trim() || undefined;
    case "connect":
    case "disconnect":
    case "authorize":
    case "logout":
      return requireServer(params);
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
      ...(server.oauthState ? [`oauth: ${server.oauthState}`] : []),
    ].join("\n")),
  ].join("\n\n");
}

export const mcpServerTool = defineTool<typeof mcpServerParametersSchema, McpServerResultDetails>({
  name: "mcp_server",
  label: "MCP Server",
  description: [
    "Inspect and manage configured MCP server state.",
    "Do not connect routinely before using mcp_tool; mcp_tool list and call initialize servers automatically.",
    "For an OAuth server that requires user authorization, use the authorize action before retrying mcp_tool.",
  ].join(" "),
  promptSnippet: "Inspect configured MCP server status, control availability, or authorize and log out one OAuth server when needed.",
  renderCall: (args, theme, context) => renderMcpServerCall(args, theme, context),
  renderResult: (result, options, theme, context) => renderMcpServerResult(result, options, theme, context),
  parameters: mcpServerParametersSchema,
  async execute(_toolCallId, params, signal) {
    const serverName = validateInvocation(params);
    const registry = requireCurrentServerRegistry();

    if (params.action === "status") {
      try {
        if (serverName !== undefined) {
          const server = await registry.getServerSnapshot(serverName);
          if (!server) {
            throw new Error(`Unknown MCP server: ${serverName}`);
          }
          return {
            content: [{
              type: "text",
              text: [
                server.connectState,
                ...(server.oauthState ? [`oauth: ${server.oauthState}`] : []),
              ].join("\n"),
            }],
            details: {
              kind: "status",
              serverName: server.name,
              connectState: server.connectState,
              ...(server.oauthState ? { oauthState: server.oauthState } : {}),
            },
          };
        }

        const status = await registry.getStatus();
        return {
          content: [{ type: "text", text: formatServerStatus(status) }],
          details: {
            kind: "status",
            connectedCount: status.connectedCount,
            totalCount: status.totalCount,
          },
        };
      } finally {
        await refreshFooterStatus(registry);
      }
    }

    if (params.action === "connect") {
      try {
        await registry.connectServer(serverName!, signal);
      } finally {
        await refreshFooterStatus(registry);
      }
      return {
        content: [{ type: "text", text: "connected" }],
        details: { kind: "connect" },
      };
    }

    if (params.action === "disconnect") {
      try {
        await registry.disconnectServer(serverName!);
      } finally {
        await refreshFooterStatus(registry);
      }
      return {
        content: [{ type: "text", text: "disconnected" }],
        details: { kind: "disconnect" },
      };
    }

    if (params.action === "authorize") {
      try {
        await registry.authorizeServer(serverName!, signal);
      } finally {
        await refreshFooterStatus(registry);
      }
      return {
        content: [{ type: "text", text: "authorized" }],
        details: { kind: "authorize" },
      };
    }

    try {
      await registry.logoutServer(serverName!);
    } finally {
      await refreshFooterStatus(registry);
    }
    return {
      content: [{ type: "text", text: "logged out" }],
      details: { kind: "logout" },
    };
  },
});

export function registerMcpServerTool(pi: ExtensionAPI): void {
  pi.registerTool(mcpServerTool);
}
