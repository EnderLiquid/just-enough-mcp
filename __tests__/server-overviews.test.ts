import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadServerOverview } from "../extensions/config/server-overviews.js";
import type { ServerConfig } from "../extensions/modeling/types.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `jem-overview-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadServerOverview", () => {
  it("prefers configured overview path over auto overview", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const configOverviewPath = join(root, "explicit.md");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configOverviewPath, "# Title\nConfigured summary line\nMore details\n", "utf8");
    writeFileSync(join(overviewDir, "tavily.md"), "Auto summary line\n", "utf8");

    const config: ServerConfig = {
      transport: "http",
      url: "https://example.com/mcp",
      overview: "explicit.md",
    };

    const overview = loadServerOverview("tavily", config, configPath, overviewDir);
    expect(overview.source).toBe("config");
    expect(overview.summary).toBe("Configured summary line");
    expect(overview.path).toBe(configOverviewPath);
  });

  it("falls back to auto overview file by server name", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "# Tavily\nSearch and extract web content\n", "utf8");

    const config: ServerConfig = {
      transport: "stdio",
      command: "npx",
    };

    const overview = loadServerOverview("tavily", config, configPath, overviewDir);
    expect(overview.source).toBe("auto");
    expect(overview.summary).toBe("Search and extract web content");
  });
});
