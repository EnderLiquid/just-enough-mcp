import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryBootstrapOverviewFromDescription } from "../src/core/overview/overview-bootstrap.js";
import type { ResolvedServerConfig } from "../src/core/modeling/types.js";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-overview-bootstrap");

function makeServer(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return makeResolvedServerConfig({
    name: "tavily",
    overview: {
      name: "tavily",
      content: "No overview configured yet.",
      source: "none",
    },
    definition: {
      transport: "http",
      url: "https://example.com/mcp",
    },
    ...overrides,
  });
}

describe("tryBootstrapOverviewFromDescription", () => {
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("从服务器描述创建最小化 overview 草稿", async () => {
    const root = tempDirs.create();
    const server = makeServer();

    const result = await tryBootstrapOverviewFromDescription(
      server,
      root,
      "Search and extract web content.",
    );

    expect(result).toEqual({
      created: true,
      path: join(root, "tavily.md"),
    });
    expect(existsSync(join(root, "tavily.md"))).toBe(true);
    expect(readFileSync(join(root, "tavily.md"), "utf8")).toBe("# tavily\n\nSearch and extract web content.\n");
  });

  it("自动 overview 文件已存在时跳过创建", async () => {
    const root = tempDirs.create();
    writeFileSync(join(root, "tavily.md"), "# Tavily\n\nManual overview\n", "utf8");
    const server = makeServer();

    const result = await tryBootstrapOverviewFromDescription(
      server,
      root,
      "Search and extract web content.",
    );

    expect(result).toEqual({
      created: false,
      path: join(root, "tavily.md"),
    });
    expect(readFileSync(join(root, "tavily.md"), "utf8")).toBe("# Tavily\n\nManual overview\n");
  });

  it("服务器使用显式 overview 配置或描述为空时跳过创建", async () => {
    const root = tempDirs.create();
    const explicitServer = makeServer({ hasExplicitOverviewConfig: true });
    const emptyDescriptionServer = makeServer();

    await expect(
      tryBootstrapOverviewFromDescription(explicitServer, root, "Search and extract web content."),
    ).resolves.toBeUndefined();
    await expect(tryBootstrapOverviewFromDescription(emptyDescriptionServer, root, "   ")).resolves.toBeUndefined();
    expect(existsSync(join(root, "tavily.md"))).toBe(false);
  });
});
