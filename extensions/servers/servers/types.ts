import type { CompatibilityProfile, ResolvedServerConfig, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";

export interface McpServer {
  readonly name: string;
  readonly profile: CompatibilityProfile;
  readonly config: ResolvedServerConfig;

  snapshot(): ServerSnapshot;
  connect(signal?: AbortSignal): Promise<ServerSnapshot>;
  getCatalog(signal?: AbortSignal): Promise<ServerCatalogResult>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallExecutionResult>;
  close(): Promise<void>;
  getServerDescription(): string | undefined;
}
