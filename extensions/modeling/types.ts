import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResultPresentationSettings } from "./materialization.js";

export type ServerTransportKind = "stdio" | "http";
export type ServerConnectionMode = "lazy" | "eager";
export type RuntimeServerStatus = "disconnected" | "connecting" | "connected" | "error";

export type CompatibilityProfileId =
  | "stdio-tools-pragmatic"
  | "http-tools-public"
  | "http-tools-token";

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

export type ConfiguredServerConfig = BaseServerConfig & ServerTransportConfig;

export interface RawPluginConfig {
  resultPresentation?: unknown;
  servers?: Record<string, unknown>;
}

export type ResolvedServerSpec = (Omit<BaseServerConfig, "overview"> & ServerTransportConfig) & {
  name: string;
  connectionMode: ServerConnectionMode;
  hasExplicitOverviewConfig: boolean;
  overviewPath?: string;
  overview: ServerOverview;
  initialProfileId: CompatibilityProfileId;
};

export interface PluginConfigLoadResult {
  configPath: string;
  overviewDir: string;
  resultPresentation: ResultPresentationSettings;
  servers: ResolvedServerSpec[];
}

export interface McpFooterStatus {
  connectedServers: number;
  totalServers: number;
  text: string;
}

export interface RuntimeServerState {
  config: ResolvedServerSpec;
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

export const DEFAULT_RUNTIME_CAPABILITIES: McpRuntimeCapabilities = {
  supportsTools: true,
  supportsResources: false,
  supportsPrompts: false,
  supportsSampling: false,
  supportsElicitation: false,
};

export const DEFAULT_CONNECTION_MODE: ServerConnectionMode = "lazy";
