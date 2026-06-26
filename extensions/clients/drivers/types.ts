import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ServerDriver {
  open(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  getServerDescription(): string | undefined;
}
