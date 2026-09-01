import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const PLUGIN_DATA_DIR_NAME = "just-enough-mcp";
const CONFIG_FILE_NAME = "config.json";
const OVERVIEW_DIR_NAME = "overviews";
const ARTIFACTS_DIR_NAME = "artifacts";
const OAUTH_DIR_NAME = "oauth";
const OAUTH_CREDENTIAL_FILE_NAME = "credentials.json";

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

export function getOauthCredentialsFilePath(): string {
  return join(getPluginDataDir(), OAUTH_DIR_NAME, OAUTH_CREDENTIAL_FILE_NAME);
}
