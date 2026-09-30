import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedServerConfig } from "../modeling/types.js";

export interface OverviewBootstrapResult {
  created: boolean;
  path: string;
}

function normalizeDescription(description: string): string {
  return description.replace(/\r\n/g, "\n").trim();
}

function buildOverviewStub(serverName: string, description: string): string {
  return `# ${serverName}\n\n${normalizeDescription(description)}\n`;
}

export async function tryBootstrapOverviewFromDescription(
  server: ResolvedServerConfig,
  overviewDirectoryPath: string,
  description: string | undefined,
): Promise<OverviewBootstrapResult | undefined> {
  if (server.hasExplicitOverviewConfig) {
    return undefined;
  }

  if (server.overview.source !== "none") {
    return undefined;
  }

  if (typeof description !== "string") {
    return undefined;
  }

  const normalizedDescription = normalizeDescription(description);
  if (normalizedDescription.length === 0) {
    return undefined;
  }

  const overviewPath = join(overviewDirectoryPath, `${server.name}.md`);
  const content = buildOverviewStub(server.name, normalizedDescription);

  await mkdir(dirname(overviewPath), { recursive: true });

  try {
    await writeFile(overviewPath, content, { encoding: "utf8", flag: "wx" });
    return {
      created: true,
      path: overviewPath,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;

    if (code === "EEXIST") {
      return {
        created: false,
        path: overviewPath,
      };
    }

    throw error;
  }
}
