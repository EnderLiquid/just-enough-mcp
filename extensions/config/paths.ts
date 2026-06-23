import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "just-enough-mcp.json";
export const OVERVIEW_DIR_NAME = "mcp-overviews";

export function getPluginConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function getOverviewDirectoryPath(): string {
  return join(getAgentDir(), OVERVIEW_DIR_NAME);
}
