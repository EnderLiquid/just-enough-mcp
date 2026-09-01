import type { ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";

export interface ServerDescriptionReadyEvent {
  config: ResolvedServerConfig;
  description: string;
}

export interface McpServer {
  readonly name: string;
  readonly config: ResolvedServerConfig;

  snapshot(): ServerSnapshot;
  connect(signal?: AbortSignal): Promise<ServerSnapshot>;
  getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult>;
  authorize?(signal?: AbortSignal): Promise<ServerSnapshot>;
  logout?(): Promise<ServerSnapshot>;
  close(): Promise<ServerSnapshot>;
}

export function supportsOauthControls(
  server: McpServer,
): server is McpServer & Required<Pick<McpServer, "authorize" | "logout">> {
  return typeof server.authorize === "function" && typeof server.logout === "function";
}
