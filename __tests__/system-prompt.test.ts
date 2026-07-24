import { describe, expect, it } from "vitest";
import type { PluginConfigLoadResult, ResolvedServerConfig } from "../extensions/modeling/types.js";
import { createServerOverviewPrompt } from "../extensions/prompting/system-prompt.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

function makeServer(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return makeResolvedServerConfig({
    name: "tavily",
    overviewPath: "C:/Users/Admin/.pi/agent/mcp-overviews/tavily.md",
    overview: {
      name: "tavily",
      content: "# tavily\n\nSearch and extract web content.",
      source: "auto",
      path: "C:/Users/Admin/.pi/agent/mcp-overviews/tavily.md",
    },
    definition: {
      transport: "http",
      url: "https://example.com/mcp",
    },
    ...overrides,
  });
}

function makeConfig(overrides: Partial<PluginConfigLoadResult> = {}): PluginConfigLoadResult {
  return makePluginConfig({
    servers: [makeServer()],
    ...overrides,
  });
}

describe("createServerOverviewPrompt", () => {
  it("includes overview guidance, maintenance notes, and resolved overview paths", () => {
    const prompt = createServerOverviewPrompt(makeConfig());

    expect(prompt).toContain("Reality:");
    expect(prompt).toContain("Scope:");
    expect(prompt).toContain("Connection behavior:");
    expect(prompt).toContain("Overviews:");
    expect(prompt).toContain("Overview maintenance:");
    expect(prompt).toContain('mcp_tool({ action: "list", server: "<name>" })');
    expect(prompt).toContain('mcp_tool({ action: "call", server: "<name>", tool: "<tool>", args: { ... } })');
    expect(prompt).toContain('mcp_server({ action: "disconnect", server: "<name>" })');
    expect(prompt).toContain("Do not call `mcp_server` connect as a routine prerequisite");
    expect(prompt).not.toContain("single `mcp` tool");
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
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\nNo overview configured yet.");
  });
});
