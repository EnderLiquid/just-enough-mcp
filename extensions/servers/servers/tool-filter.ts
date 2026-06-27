import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerConfig, ServerDefinition } from "../../modeling/types.js";

export interface ToolNameFilter {
  include: Set<string>;
  exclude: Set<string>;
}

function readToolNameList(definition: ServerDefinition, fieldName: "includeTools" | "excludeTools", serverName: string): string[] {
  const value = definition[fieldName];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Server "${serverName}" field "${fieldName}" must be an array of non-empty strings.`);
  }

  return value;
}

export function createToolNameFilter(config: ResolvedServerConfig): ToolNameFilter {
  return {
    include: new Set(readToolNameList(config.definition, "includeTools", config.name)),
    exclude: new Set(readToolNameList(config.definition, "excludeTools", config.name)),
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
