import { describe, expect, it } from "vitest";
import type { PluginConfigLoadResult, ResolvedServerConfig } from "../extensions/modeling/types.js";
import { createServerOverviewPrompt } from "../extensions/prompting/system-prompt.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

function makeServer(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return makeResolvedServerConfig({
    name: "tavily",
    overview: {
      name: "tavily",
      content: "# tavily\n\nSearch and extract web content.",
      source: "auto",
      path: "C:/Users/Admin/.pi/agent/just-enough-mcp/overviews/tavily.md",
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
  it("overview 没有 markdown 标题时添加合成标题", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
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
        overview: {
          name: "demo",
          content: "    # Example code",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\n    # Example code");
  });

  it("在 overview 内容前输出正斜杠规范化后的路径", () => {
    const overviewPath = "C:\\Users\\Admin\\.pi\\agent\\just-enough-mcp\\overviews\\demo.md";
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overview: {
          name: "demo",
          content: "Demo overview.",
          source: "auto",
          path: overviewPath,
        },
      })],
    }));

    expect(prompt).toContain(
      "> Overview file: C:/Users/Admin/.pi/agent/just-enough-mcp/overviews/demo.md\n\n# demo\n\nDemo overview.",
    );
  });

  it("overview 没有路径时不输出路径前缀", () => {
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [makeServer({
        name: "demo",
        overview: {
          name: "demo",
          content: "Overview without a path.",
          source: "none",
        },
      })],
    }));

    expect(prompt).toContain("# demo\n\nOverview without a path.");
    expect(prompt).not.toContain("> Overview file:");
  });

  it("按配置顺序拼接多个 overview", () => {
    const alphaPath = "C:/overviews/alpha.md";
    const betaPath = "C:/overviews/beta.md";
    const prompt = createServerOverviewPrompt(makeConfig({
      servers: [
        makeServer({
          name: "alpha",
          overview: {
            name: "alpha",
            content: "Alpha overview.",
            source: "auto",
            path: alphaPath,
          },
        }),
        makeServer({
          name: "beta",
          overview: {
            name: "beta",
            content: "Beta overview.",
            source: "auto",
            path: betaPath,
          },
        }),
      ],
    }));
    const alphaBlock = "> Overview file: C:/overviews/alpha.md\n\n# alpha\n\nAlpha overview.";
    const betaBlock = "> Overview file: C:/overviews/beta.md\n\n# beta\n\nBeta overview.";

    expect(prompt).toContain(alphaBlock);
    expect(prompt).toContain(betaBlock);
    expect(prompt.indexOf(alphaBlock)).toBeLessThan(prompt.indexOf(betaBlock));
  });
});
