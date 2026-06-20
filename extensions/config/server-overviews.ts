import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getOverviewDirectoryPath } from "./paths.js";
import type { ServerConfig, ServerOverview, ServerTransportKind } from "../modeling/types.js";

function inferTransport(config: ServerConfig): ServerTransportKind {
  return config.transport;
}

function resolveConfiguredOverviewPath(configPath: string, overviewPath: string): string {
  if (isAbsolute(overviewPath)) {
    return overviewPath;
  }

  return resolve(dirname(configPath), overviewPath);
}

function readOverviewSummary(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    return "Overview file exists but does not contain any plain-text summary yet.";
  }

  return lines[0];
}

export function loadServerOverview(
  serverName: string,
  config: ServerConfig,
  configPath: string,
  overviewDirectoryPath = getOverviewDirectoryPath(),
): ServerOverview {
  const transport = inferTransport(config);

  if (config.overview) {
    const explicitPath = resolveConfiguredOverviewPath(configPath, config.overview);
    if (existsSync(explicitPath)) {
      const summary = readOverviewSummary(readFileSync(explicitPath, "utf8"));
      return {
        name: serverName,
        summary,
        transport,
        source: "config",
        path: explicitPath,
      };
    }
  }

  const autoPath = join(overviewDirectoryPath, `${serverName}.md`);
  if (existsSync(autoPath)) {
    const summary = readOverviewSummary(readFileSync(autoPath, "utf8"));
    return {
      name: serverName,
      summary,
      transport,
      source: "auto",
      path: autoPath,
    };
  }

  return {
    name: serverName,
    summary: "No overview configured yet.",
    transport,
    source: "none",
  };
}
