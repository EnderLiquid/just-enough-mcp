import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type ServerConnectionMode = "lazy" | "eager";
export type ServerConnectState = "disconnected" | "connecting" | "connected" | "disconnecting";
export type ServerOauthState =
  | "authorization-required"
  | "authorizing"
  | "authorized"
  | "unknown";

/** 配置文件中的未解析 server definition。 */
export type ServerDefinition = Record<string, unknown>;

export interface ServerOverview {
  name: string;
  content: string;
  source: "config" | "auto" | "none";
  /** 实际读取到 overview 内容的文件路径。 */
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
  overview?: string;
}

export interface ResolvedStdioTransport {
  kind: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ResolvedOauthConfig {
  clientMetadataUrl?: string;
  /** DCR client_name；未配置时由 identity 归一化填充默认名称。 */
  clientName?: string;
  scope?: string;
  profile: string;
}

export interface ResolvedHttpTransport {
  kind: "http";
  url: URL;
  auth: "public" | "static" | "oauth";
  headers?: Record<string, string>;
  bearerToken?: string;
  oauth?: ResolvedOauthConfig;
}

export type ResolvedServerTransport = ResolvedStdioTransport | ResolvedHttpTransport;

export interface ResolvedToolFilter {
  include: string[];
  exclude: string[];
}

export interface ResolvedServerConfig {
  name: string;
  connectionMode: ServerConnectionMode;
  /** 用户声明的显式 overview 路径，即使该文件暂时不可用也保留。 */
  configuredOverviewPath?: string;
  overview: ServerOverview;
  transport: ResolvedServerTransport;
  toolFilter: ResolvedToolFilter;
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
