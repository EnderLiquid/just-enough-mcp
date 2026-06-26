import { describe, expect, it } from "vitest";
import { createServerOverviewPrompt } from "../extensions/prompting/system-prompt.js";
import type { PluginConfigLoadResult, ResolvedServerConfig } from "../extensions/modeling/types.js";

function makeServer(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "tavily",
    transport: "http",
    url: "https://example.com/mcp",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overviewPath: "C:/Users/Admin/.pi/agent/mcp-overviews/tavily.md",
    overview: {
      name: "tavily",
      content: "# tavily\n\nSearch and extract web content.",
      transport: "http",
      source: "auto",
      path: "C:/Users/Admin/.pi/agent/mcp-overviews/tavily.md",
    },
    ...overrides,
  } as ResolvedServerConfig;
}

function makeConfig(overrides: Partial<PluginConfigLoadResult> = {}): PluginConfigLoadResult {
  return {
    configPath: "C:/Users/Admin/.pi/agent/just-enough-mcp.json",
    overviewDir: "C:/Users/Admin/.pi/agent/mcp-overviews",
    resultPresentation: {
      artifactRoot: ".pi/mcp",
      summaryItemCount: 6,
      previewFullCharsPerItem: 1500,
      previewTruncateToCharsPerItem: 600,
      hardMaxChars: 40000,
      prettyPrintJson: true,
      collapsedPreviewLines: 4,
    },
    servers: [makeServer()],
    ...overrides,
  };
}

describe("createServerOverviewPrompt", () => {
  it("includes overview guidance, maintenance notes, and resolved overview paths", () => {
    const prompt = createServerOverviewPrompt(makeConfig());

    expect(prompt).toContain("Reality:");
    expect(prompt).toContain("Scope:");
    expect(prompt).toContain("Connection behavior:");
    expect(prompt).toContain("Overviews:");
    expect(prompt).toContain("Overview maintenance:");
    expect(prompt).toContain("/reload");
    expect(prompt).toContain("> Overview file: C:/Users/Admin/.pi/agent/mcp-overviews/tavily.md");
    expect(prompt).toContain("# tavily\n\nSearch and extract web content.");
  });

  it("adds a synthetic heading when an overview has no markdown heading", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overviewPath: undefined,
        overview: {
          name: "demo",
          content: "No overview configured yet.",
          transport: "http",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\nNo overview configured yet.");
  });
});
