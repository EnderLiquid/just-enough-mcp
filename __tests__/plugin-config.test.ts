import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginConfigFromPaths } from "../extensions/config/plugin-config.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-config");

describe("loadPluginConfigFromPaths", () => {
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("解析带连接模式、物化设置和 TUI 设置的服务器定义", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "Search and extract web content.\nUse it for latest info.\n", "utf8");

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        summaryItemCount: 3,
        previewFullCharsPerItem: 240,
        previewTruncateToCharsPerItem: 120,
        hardMaxChars: 5000,
        prettyPrintJson: false,
        artifactRoot: "custom-artifacts",
      },
      tui: {
        renderMode: "hidden",
        expandedModeCollapsedLines: 5,
      },
      servers: {
        tavily: {
          url: "https://example.com/mcp",
          bearerToken: "token-123",
          connectionMode: "eager",
        },
        localTools: {
          command: "npx",
          args: ["-y", "some-server"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths(configPath, overviewDir);
    expect(loaded.servers).toHaveLength(2);

    const tavily = loaded.servers.find(server => server.name === "tavily");
    const localTools = loaded.servers.find(server => server.name === "localTools");

    expect(loaded.materialization.summaryItemCount).toBe(3);
    expect(loaded.materialization.previewFullCharsPerItem).toBe(240);
    expect(loaded.materialization.previewTruncateToCharsPerItem).toBe(120);
    expect(loaded.materialization.hardMaxChars).toBe(5000);
    expect(loaded.materialization.prettyPrintJson).toBe(false);
    expect(loaded.materialization.artifactRoot).toBe("custom-artifacts");
    expect(loaded.tui.expandedModeCollapsedLines).toBe(5);
    expect(loaded.tui.renderMode).toBe("hidden");
    expect(tavily?.definition).toMatchObject({
      url: "https://example.com/mcp",
      bearerToken: "token-123",
      connectionMode: "eager",
    });
    expect(tavily?.connectionMode).toBe("eager");
    expect(tavily?.overview.content).toContain("Search and extract web content.");
    expect(localTools?.definition).toMatchObject({
      command: "npx",
      args: ["-y", "some-server"],
    });
    expect(localTools?.connectionMode).toBe("lazy");
  });

  it("省略时使用默认物化和 TUI 设置", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        localTools: {
          command: "npx",
          args: ["-y", "some-server"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths(configPath, overviewDir);

    expect(loaded.materialization.previewFullCharsPerItem).toBe(1500);
    expect(loaded.materialization.previewTruncateToCharsPerItem).toBe(600);
    expect(loaded.tui.renderMode).toBe("expanded");
    expect(loaded.tui.expandedModeCollapsedLines).toBe(4);
    expect(loaded.servers[0]?.definition).toMatchObject({
      command: "npx",
    });
  });

  it("拒绝非对象的服务器配置", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        broken: "not-an-object",
      },
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/broken/);
  });

  it("拒绝无效的物化设置", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        summaryItemCount: 0,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/materialization.summaryItemCount/);
  });

  it("拒绝不一致的物化预览阈值", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        previewFullCharsPerItem: 120,
        previewTruncateToCharsPerItem: 121,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/materialization.previewTruncateToCharsPerItem/);
  });

  it("接受所有 TUI 渲染模式", () => {
    for (const mode of ["hidden", "minimal", "expanded"] as const) {
      const root = tempDirs.create();
      const configPath = join(root, "just-enough-mcp.json");
      const overviewDir = join(root, "mcp-overviews");
      mkdirSync(overviewDir, { recursive: true });

      writeFileSync(configPath, JSON.stringify({
        tui: {
          renderMode: mode,
        },
        servers: {},
      }, null, 2), "utf8");

      const loaded = loadPluginConfigFromPaths(configPath, overviewDir);
      expect(loaded.tui.renderMode).toBe(mode);
    }
  });

  it("拒绝无效的 TUI 渲染模式", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      tui: {
        renderMode: "compact",
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/tui.renderMode/);
  });

  it("拒绝无效的 expanded 模式折叠行数", () => {
    const root = tempDirs.create();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overviews");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      tui: {
        expandedModeCollapsedLines: 0,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/tui.expandedModeCollapsedLines/);
  });
});
