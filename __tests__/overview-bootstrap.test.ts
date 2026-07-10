import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryBootstrapOverviewFromDescription } from "../extensions/config/overview-bootstrap.js";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
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

  it("creates a minimal overview stub from server description", () => {
    const root = tempDirs.create();
    const server = makeServer();

    const result = tryBootstrapOverviewFromDescription(
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

  it("skips creation when an auto overview file already exists", () => {
    const root = tempDirs.create();
    writeFileSync(join(root, "tavily.md"), "# Tavily\n\nManual overview\n", "utf8");
    const server = makeServer();

    const result = tryBootstrapOverviewFromDescription(
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

  it("skips creation when server uses explicit overview config or empty description", () => {
    const root = tempDirs.create();
    const explicitServer = makeServer({ hasExplicitOverviewConfig: true });
    const emptyDescriptionServer = makeServer();

    expect(tryBootstrapOverviewFromDescription(explicitServer, root, "Search and extract web content.")).toBeUndefined();
    expect(tryBootstrapOverviewFromDescription(emptyDescriptionServer, root, "   ")).toBeUndefined();
    expect(existsSync(join(root, "tavily.md"))).toBe(false);
  });
});
