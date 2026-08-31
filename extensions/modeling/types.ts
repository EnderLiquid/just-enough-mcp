import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MaterializationSettings, TuiResultRenderSettings } from "../artifacts/types.js";

export type ServerConnectionMode = "lazy" | "eager";
export type ServerConnectState = "disconnected" | "connecting" | "connected" | "disconnecting";

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

export interface RawPluginConfig {
  materialization?: unknown;
  tui?: unknown;
  servers?: Record<string, unknown>;
}

export interface ResolvedServerConfig {
  name: string;
  connectionMode: ServerConnectionMode;
  hasExplicitOverviewConfig: boolean;
  overviewPath?: string;
  overview: ServerOverview;
  definition: ServerDefinition;
}

export interface PluginConfigLoadResult {
  configPath: string;
  overviewDir: string;
  artifactDir: string;
  materialization: MaterializationSettings;
  tui: TuiResultRenderSettings;
  servers: ResolvedServerConfig[];
}

export interface ServerSnapshot {
  name: string;
  connectState: ServerConnectState;
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

export type McpServerResultDetails =
  | { kind: "status"; connectedCount: number; totalCount: number }
  | { kind: "status"; serverName: string; connectState: ServerConnectState }
  | { kind: "connect" }
  | { kind: "disconnect" };

export type McpToolResultDetails =
  | { kind: "list"; toolCount: number }
  | { kind: "call"; payloadItemCount: number; outcome: "success" | "error" };

export const DEFAULT_RUNTIME_CAPABILITIES: McpRuntimeCapabilities = {
  supportsTools: true,
  supportsResources: false,
  supportsPrompts: false,
  supportsSampling: false,
  supportsElicitation: false,
};

export const DEFAULT_CONNECTION_MODE: ServerConnectionMode = "lazy";
