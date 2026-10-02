import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerOverview } from "../packages/core/src/overview/server-overviews.js";
import type { BaseServerConfig } from "../packages/core/src/modeling/types.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-overview");

describe("loadServerOverview", () => {
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("显式配置的 overview 路径优先于自动 overview", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const configOverviewPath = join(root, "explicit.md");
    const overviewDir = join(root, "overviews");
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

  it("无可用 overview 时返回显式兜底文案", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");

    const overview = loadServerOverview("tavily", {}, configPath, overviewDir);

    expect(overview).toEqual({
      name: "tavily",
      content: "No overview is available for this server yet.",
      source: "none",
    });
  });

  it("按服务器名回退到自动 overview 文件", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "# Tavily\nSearch and extract web content\nUse it for latest info.\n", "utf8");

    const config: BaseServerConfig = {};

    const overview = loadServerOverview("tavily", config, configPath, overviewDir);
    expect(overview.source).toBe("auto");
    expect(overview.content).toBe("# Tavily\nSearch and extract web content\nUse it for latest info.");
  });
});
