import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const PLUGIN_DATA_DIR_NAME = "just-enough-mcp";
const CONFIG_FILE_NAME = "config.json";
const OVERVIEW_DIR_NAME = "overviews";
const ARTIFACTS_DIR_NAME = "artifacts";
const OAUTH_DIRECTORY_NAME = "oauth";

export function getPluginDataDir(): string {
  return join(getAgentDir(), PLUGIN_DATA_DIR_NAME);
}

export function getPluginConfigPath(): string {
  return join(getPluginDataDir(), CONFIG_FILE_NAME);
}

export function getOverviewDirectoryPath(): string {
  return join(getPluginDataDir(), OVERVIEW_DIR_NAME);
}

export function getArtifactsDirectoryPath(): string {
  return join(getPluginDataDir(), ARTIFACTS_DIR_NAME);
}

export function getOAuthBrokerDirectoryPath(): string {
  return join(getPluginDataDir(), OAUTH_DIRECTORY_NAME);
}
