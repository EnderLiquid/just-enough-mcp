import type { McpFooterStatus } from "../modeling/types.js";

export function buildFooterStatus(connectedServers: number, totalServers: number): McpFooterStatus {
  return {
    connectedServers,
    totalServers,
    text: `${connectedServers}/${totalServers} MCP`,
  };
}
