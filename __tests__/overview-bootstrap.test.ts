import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryBootstrapOverviewFromDescription } from "../extensions/config/overview-bootstrap.js";
import type { ResolvedServerSpec } from "../extensions/modeling/types.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `jem-overview-bootstrap-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeServer(overrides: Partial<ResolvedServerSpec> = {}): ResolvedServerSpec {
  return {
    name: "tavily",
    transport: "http",
    url: "https://example.com/mcp",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    initialProfileId: "http-tools-public",
    overview: {
      name: "tavily",
      content: "No overview configured yet.",
      transport: "http",
      source: "none",
    },
    ...overrides,
  } as ResolvedServerSpec;
}

describe("tryBootstrapOverviewFromDescription", () => {
  it("creates a minimal overview stub from server description", () => {
    const root = makeTempDir();
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
    const root = makeTempDir();
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
    const root = makeTempDir();
    const explicitServer = makeServer({ hasExplicitOverviewConfig: true });
    const emptyDescriptionServer = makeServer();

    expect(tryBootstrapOverviewFromDescription(explicitServer, root, "Search and extract web content.")).toBeUndefined();
    expect(tryBootstrapOverviewFromDescription(emptyDescriptionServer, root, "   ")).toBeUndefined();
    expect(existsSync(join(root, "tavily.md"))).toBe(false);
  });
});
