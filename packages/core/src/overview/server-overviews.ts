import { readFileSync } from "node:fs";
import {isAbsolute, join} from "node:path";
import type { BaseServerConfig, ServerOverview } from "../modeling/types.js";

export interface ServerOverviewResolution {
  overview: ServerOverview;
  configuredPath?: string;
  warning?: string;
}

function normalizeOverviewContent(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return "Overview file exists but is empty.";
}

function tryReadOverview(path: string): string | undefined {
  try {
    return normalizeOverviewContent(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function assertAbsoluteConfiguredOverviewPath(configuredOverviewPath: string): void {
  if (!isAbsolute(configuredOverviewPath)) {
    throw new Error("configuredOverviewPath must be converted to an absolute path before being passed to core.")
  }
}

export function resolveServerOverview(
  serverName: string,
  config: BaseServerConfig,
  overviewDirectoryPath: string,
): ServerOverviewResolution {
  const configuredPath = config.overview;
  if (configuredPath !== undefined) {
    const content = tryReadOverview(configuredPath);
    if (content !== undefined) {
      return {
        configuredPath,
        overview: {
          name: serverName,
          content,
          source: "config",
          path: configuredPath,
        },
      };
    }
  }

  const autoPath = join(overviewDirectoryPath, `${serverName}.md`);
  const autoContent = tryReadOverview(autoPath);
  if (autoContent !== undefined) {
    return {
      ...(configuredPath === undefined ? {} : { configuredPath }),
      overview: {
        name: serverName,
        content: autoContent,
        source: "auto",
        path: autoPath,
      },
      ...(configuredPath === undefined
        ? {}
        : {
            warning: `Server "${serverName}" overview file "${configuredPath}" could not be loaded; using the default overview instead.`,
          }),
    };
  }

  return {
    ...(configuredPath === undefined ? {} : { configuredPath }),
    overview: {
      name: serverName,
      content: "No overview is available for this server yet.",
      source: "none",
    },
    ...(configuredPath === undefined
      ? {}
      : {
          warning: `Server "${serverName}" overview file "${configuredPath}" could not be loaded; using the default overview location instead.`,
        }),
  };
}

export function loadServerOverview(
  serverName: string,
  config: BaseServerConfig,
  overviewDirectoryPath: string,
): ServerOverview {
  return resolveServerOverview(serverName, config, overviewDirectoryPath).overview;
}
