import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MaterializationSettings, TuiResultRenderSettings } from "../artifacts/types.js";

export type ServerConnectionMode = "lazy" | "eager";
export type ServerConnectState = "disconnected" | "connecting" | "connected";

export type CompatibilityProfile =
  | "stdio-tools-pragmatic"
  | "http-tools-public"
  | "http-tools-token";

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
  materialization: MaterializationSettings;
  tui: TuiResultRenderSettings;
  servers: ResolvedServerConfig[];
}

export type ServerSnapshot =
  | {
      name: string;
      profile: "stdio-tools-pragmatic";
      connectState: ServerConnectState;
      tools?: Tool[];
    }
  | {
      name: string;
      profile: "http-tools-public";
      connectState: ServerConnectState;
      tools?: Tool[];
    }
  | {
      name: string;
      profile: "http-tools-token";
      connectState: ServerConnectState;
      tools?: Tool[];
    };

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
