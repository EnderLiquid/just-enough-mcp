import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerConfig } from "../../modeling/types.js";

export interface ToolNameFilter {
  include: Set<string>;
  exclude: Set<string>;
}

export function createToolNameFilter(config: ResolvedServerConfig): ToolNameFilter {
  return {
    include: new Set(config.toolFilter.include),
    exclude: new Set(config.toolFilter.exclude),
  };
}

export function isToolNameAllowed(toolName: string, filter: ToolNameFilter): boolean {
  const included = filter.include.size === 0 || filter.include.has(toolName);
  return included && !filter.exclude.has(toolName);
}

export function isToolNameFilteredByConfig(toolName: string, filter: ToolNameFilter): boolean {
  return !isToolNameAllowed(toolName, filter);
}

export function applyToolNameFilter(tools: Tool[], filter: ToolNameFilter): Tool[] {
  return tools.filter(tool => isToolNameAllowed(tool.name, filter));
}
