import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerOverview } from "../extensions/config/server-overviews.js";
import type { BaseServerConfig } from "../extensions/modeling/types.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-overview");

describe("loadServerOverview", () => {
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("prefers configured overview path over auto overview", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const configOverviewPath = join(root, "explicit.md");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configOverviewPath, "# Title\nConfigured overview line\nMore details\n", "utf8");
    writeFileSync(join(overviewDir, "tavily.md"), "Auto overview line\n", "utf8");

    const config: BaseServerConfig = {
      overview: "explicit.md",
    };

    const overview = loadServerOverview("tavily", config, configPath, overviewDir);
    expect(overview.source).toBe("config");
    expect(overview.content).toBe("# Title\nConfigured overview line\nMore details");
    expect(overview.path).toBe(configOverviewPath);
  });

  it("returns an explicit fallback when no overview is available", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");

    const overview = loadServerOverview("tavily", {}, configPath, overviewDir);

    expect(overview).toEqual({
      name: "tavily",
      content: "No overview is available for this server yet.",
      source: "none",
    });
  });

  it("falls back to auto overview file by server name", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "# Tavily\nSearch and extract web content\nUse it for latest info.\n", "utf8");

    const config: BaseServerConfig = {};

    const overview = loadServerOverview("tavily", config, configPath, overviewDir);
    expect(overview.source).toBe("auto");
    expect(overview.content).toBe("# Tavily\nSearch and extract web content\nUse it for latest info.");
  });
});
