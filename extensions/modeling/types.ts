import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PayloadItemIndex, ResultPresentationSettings } from "./materialization.js";

export type ServerTransportKind = "stdio" | "http";
export type ServerConnectionMode = "lazy" | "eager";
export type RuntimeServerStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ServerOverview {
  name: string;
  content: string;
  transport: ServerTransportKind;
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

export interface StdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  bearerToken?: string;
}

export type ServerTransportConfig = StdioServerConfig | HttpServerConfig;

export interface BaseServerConfig {
  connectionMode?: ServerConnectionMode;
  overview?: string;
}

export type ServerConfig = BaseServerConfig & ServerTransportConfig;

export interface RawPluginConfig {
  resultPresentation?: unknown;
  servers?: Record<string, unknown>;
}

export type ResolvedServerConfig = (Omit<BaseServerConfig, "overview"> & ServerTransportConfig) & {
  name: string;
  connectionMode: ServerConnectionMode;
  overviewPath?: string;
  overview: ServerOverview;
};

export interface PluginConfigLoadResult {
  configPath: string;
  overviewDir: string;
  resultPresentation: ResultPresentationSettings;
  servers: ResolvedServerConfig[];
}

export interface McpFooterStatus {
  connectedServers: number;
  totalServers: number;
  text: string;
}

export interface RuntimeServerState {
  config: ResolvedServerConfig;
  status: RuntimeServerStatus;
  error?: string;
  tools?: Tool[];
}

export interface ServerCatalogResult {
  server: RuntimeServerState;
  tools: Tool[];
}

export interface ToolCallExecutionResult {
  server: RuntimeServerState;
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResult;
}

export interface ToolResultServerDetail {
  name: string;
  transport: ServerTransportKind;
  connectionMode: ServerConnectionMode;
  status: RuntimeServerStatus;
  overviewSource: ServerOverview["source"];
  error?: string;
}

export interface McpToolResultDetails {
  stage: string;
  servers: ToolResultServerDetail[];
  manifestPath?: string;
  payloadItemIndexes?: PayloadItemIndex[];
}

export const DEFAULT_RUNTIME_CAPABILITIES: McpRuntimeCapabilities = {
  supportsTools: true,
  supportsResources: false,
  supportsPrompts: false,
  supportsSampling: false,
  supportsElicitation: false,
};

export const DEFAULT_CONNECTION_MODE: ServerConnectionMode = "lazy";
