import type { CompatibilityProfile, ResolvedServerSpec, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";

export interface McpServer {
  readonly name: string;
  readonly profile: CompatibilityProfile;
  readonly spec: ResolvedServerSpec;

  snapshot(): ServerSnapshot;
  connect(): Promise<ServerSnapshot>;
  getCatalog(): Promise<ServerCatalogResult>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult>;
  close(): Promise<void>;
  getServerDescription(): string | undefined;
}
