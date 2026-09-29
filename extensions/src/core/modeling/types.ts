import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type ServerConnectionMode = "lazy" | "eager";
export type ServerConnectState = "disconnected" | "connecting" | "connected" | "disconnecting";
export type ServerOauthState =
  | "authorization-required"
  | "authorizing"
  | "authorized"
  | "unknown";

export type ServerDefinition = Record<string, unknown>;

export interface ServerOverview {
  name: string;
  content: string;
  source: "config" | "auto" | "none";
  path?: string;
}

export interface McpRuntimeCapabilities {
  supportsTools: boolean;
  supportsResources: boolean;
  supportsPrompts: boolean;
  supportsSampling: boolean;
  supportsElicitation: boolean;
}

export interface BaseServerConfig {
  connectionMode?: ServerConnectionMode;
  overview?: string;
}

export interface ResolvedServerConfig {
  name: string;
  connectionMode: ServerConnectionMode;
  hasExplicitOverviewConfig: boolean;
  overview: ServerOverview;
  definition: ServerDefinition;
}

export interface ServerSnapshot {
  name: string;
  connectState: ServerConnectState;
  oauthState?: ServerOauthState;
  tools?: Tool[];
  description?: string;
}

export interface ServerCatalogResult {
  server: ServerSnapshot;
  tools: Tool[];
}

export interface ToolCallExecutionResult {
  server: ServerSnapshot;
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResult;
}

export const DEFAULT_RUNTIME_CAPABILITIES: McpRuntimeCapabilities = {
  supportsTools: true,
  supportsResources: false,
  supportsPrompts: false,
  supportsSampling: false,
  supportsElicitation: false,
};

export const DEFAULT_CONNECTION_MODE: ServerConnectionMode = "lazy";
