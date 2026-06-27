import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getOverviewDirectoryPath } from "./paths.js";
import type { BaseServerConfig, ServerOverview } from "../modeling/types.js";

function resolveConfiguredOverviewPath(configPath: string, overviewPath: string): string {
  if (isAbsolute(overviewPath)) {
    return overviewPath;
  }

  return resolve(dirname(configPath), overviewPath);
}

function normalizeOverviewContent(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return "Overview file exists but is empty.";
}

export function loadServerOverview(
  serverName: string,
  config: BaseServerConfig,
  configPath: string,
  overviewDirectoryPath = getOverviewDirectoryPath(),
): ServerOverview {
  if (config.overview) {
    const explicitPath = resolveConfiguredOverviewPath(configPath, config.overview);
    if (existsSync(explicitPath)) {
      const content = normalizeOverviewContent(readFileSync(explicitPath, "utf8"));
      return {
        name: serverName,
        content,
        source: "config",
        path: explicitPath,
      };
    }
  }

  const autoPath = join(overviewDirectoryPath, `${serverName}.md`);
  if (existsSync(autoPath)) {
    const content = normalizeOverviewContent(readFileSync(autoPath, "utf8"));
    return {
      name: serverName,
      content,
      source: "auto",
      path: autoPath,
    };
  }

  return {
    name: serverName,
    content: "No overview configured yet.",
    source: "none",
  };
}
