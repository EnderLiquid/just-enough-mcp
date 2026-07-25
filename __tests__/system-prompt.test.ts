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
  it("包含 overview 指南、维护说明和已解析的 overview 路径", () => {
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

  it("overview 没有 markdown 标题时添加合成标题", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overviewPath: undefined,
        overview: {
          name: "demo",
          content: "No overview is available for this server yet.",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\nNo overview is available for this server yet.");
  });

  it("识别空行后和 Markdown 合法缩进后的标题", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overviewPath: undefined,
        overview: {
          name: "demo",
          content: "\n  ## Existing heading\n\nOverview content.",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("\n  ## Existing heading\n\nOverview content.");
    expect(prompt).not.toContain("# demo\n\n");
  });

  it("缩进的井号属于代码块时添加标题", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overviewPath: undefined,
        overview: {
          name: "demo",
          content: "    # Example code",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\n    # Example code");
  });
});
