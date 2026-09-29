import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginConfigFromPaths } from "../extensions/src/pi/config/plugin-config.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-config");

describe("loadPluginConfigFromPaths", () => {
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("解析带连接模式、物化设置和 TUI 设置的服务器定义", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "Search and extract web content.\nUse it for latest info.\n", "utf8");

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        summaryItemCount: 3,
        previewFullCharsPerItem: 240,
        previewTruncateToCharsPerItem: 120,
        hardMaxChars: 5000,
        prettyPrintJson: false,
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
        "local-tools": {
          command: "npx",
          args: ["-y", "some-server"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths([configPath], overviewDir, artifactDir);
    expect(loaded.servers).toHaveLength(2);

    const tavily = loaded.servers.find(server => server.name === "tavily");
    const localTools = loaded.servers.find(server => server.name === "local-tools");

    expect(loaded.materialization.summaryItemCount).toBe(3);
    expect(loaded.materialization.previewFullCharsPerItem).toBe(240);
    expect(loaded.materialization.previewTruncateToCharsPerItem).toBe(120);
    expect(loaded.materialization.hardMaxChars).toBe(5000);
    expect(loaded.materialization.prettyPrintJson).toBe(false);
    expect(loaded.artifactDir).toBe(artifactDir);
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
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        "local-tools": {
          command: "npx",
          args: ["-y", "some-server"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths([configPath], overviewDir, artifactDir);

    expect(loaded.materialization.previewFullCharsPerItem).toBe(1500);
    expect(loaded.materialization.previewTruncateToCharsPerItem).toBe(600);
    expect(loaded.tui.renderMode).toBe("expanded");
    expect(loaded.tui.expandedModeCollapsedLines).toBe(4);
    expect(loaded.servers[0]?.definition).toMatchObject({
      command: "npx",
    });
  });

  it("校验服务器名称", () => {
    const validNames = [
      "a",
      "a".repeat(32),
      "cua-driver",
      "foo--bar",
      "foo_",
      "foo.",
      "github.enterprise",
    ];
    const invalidNames = [
      { name: "a".repeat(33), reason: "1 to 32 lowercase" },
      { name: "Context7", reason: "1 to 32 lowercase" },
      { name: "context 7", reason: "1 to 32 lowercase" },
      { name: "中文", reason: "1 to 32 lowercase" },
      { name: "context/7", reason: "1 to 32 lowercase" },
      { name: "context\\7", reason: "1 to 32 lowercase" },
      { name: "context:7", reason: "1 to 32 lowercase" },
      { name: ".context7", reason: "1 to 32 lowercase" },
      { name: "-context7", reason: "1 to 32 lowercase" },
      { name: "_context7", reason: "1 to 32 lowercase" },
      { name: "con", reason: "Windows-reserved device name" },
      { name: "con.docs", reason: "Windows-reserved device name" },
      { name: "com1", reason: "Windows-reserved device name" },
      { name: "com9.dev", reason: "Windows-reserved device name" },
      { name: "lpt9", reason: "Windows-reserved device name" },
    ];

    for (const serverName of validNames) {
      const root = tempDirs.create();
      const configPath = join(root, "config.json");
      const overviewDir = join(root, "overviews");
      const artifactDir = join(root, "artifacts");
      writeFileSync(configPath, JSON.stringify({
        servers: {
          [serverName]: { command: "npx" },
        },
      }), "utf8");

      expect(loadPluginConfigFromPaths([configPath], overviewDir, artifactDir).servers[0]?.name).toBe(serverName);
    }

    for (const { name: serverName, reason } of invalidNames) {
      const root = tempDirs.create();
      const configPath = join(root, "config.json");
      const overviewDir = join(root, "overviews");
      const artifactDir = join(root, "artifacts");
      writeFileSync(configPath, JSON.stringify({
        servers: {
          [serverName]: { command: "npx" },
        },
      }), "utf8");

      expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(serverName);
      expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(reason);
    }
  });

  it("拒绝非对象的服务器配置", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        broken: "not-an-object",
      },
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(/broken/);
  });

  it("拒绝无效的物化设置", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        summaryItemCount: 0,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(/materialization.summaryItemCount/);
  });

  it("拒绝不一致的物化预览阈值", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      materialization: {
        previewFullCharsPerItem: 120,
        previewTruncateToCharsPerItem: 121,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(/materialization.previewTruncateToCharsPerItem/);
  });

  it("接受所有 TUI 渲染模式", () => {
    for (const mode of ["hidden", "minimal", "expanded"] as const) {
      const root = tempDirs.create();
      const configPath = join(root, "config.json");
      const overviewDir = join(root, "overviews");
      const artifactDir = join(root, "artifacts");
      mkdirSync(overviewDir, { recursive: true });

      writeFileSync(configPath, JSON.stringify({
        tui: {
          renderMode: mode,
        },
        servers: {},
      }, null, 2), "utf8");

      const loaded = loadPluginConfigFromPaths([configPath], overviewDir, artifactDir);
      expect(loaded.tui.renderMode).toBe(mode);
    }
  });

  it("拒绝无效的 TUI 渲染模式", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      tui: {
        renderMode: "compact",
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(/tui.renderMode/);
  });

  it("拒绝无效的 expanded 模式折叠行数", () => {
    const root = tempDirs.create();
    const configPath = join(root, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      tui: {
        expandedModeCollapsedLines: 0,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths([configPath], overviewDir, artifactDir)).toThrow(/tui.expandedModeCollapsedLines/);
  });

  it("按优先级合并配置层，支持禁用 server、完整替换和 overview 路径规范化", () => {
    const root = tempDirs.create();
    const globalConfigDir = join(root, "global");
    const projectConfigDir = join(root, "project");
    const globalConfigPath = join(globalConfigDir, "config.json");
    const projectConfigPath = join(projectConfigDir, "config.json");
    const overviewDir = join(root, "overviews");
    const artifactDir = join(root, "artifacts");
    const globalOverviewPath = join(globalConfigDir, "docs", "shared.md");
    const projectOverviewPath = join(projectConfigDir, "docs", "shared.md");

    mkdirSync(join(globalConfigDir, "docs"), { recursive: true });
    mkdirSync(join(projectConfigDir, "docs"), { recursive: true });
    writeFileSync(globalOverviewPath, "Global shared overview\n", "utf8");
    writeFileSync(projectOverviewPath, "Project shared overview\n", "utf8");

    writeFileSync(globalConfigPath, JSON.stringify({
      materialization: {
        summaryItemCount: 3,
        hardMaxChars: 1000,
      },
      tui: {
        renderMode: "expanded",
        expandedModeCollapsedLines: 8,
      },
      servers: {
        shared: {
          command: "node",
          args: ["global-server.mjs"],
          auth: "oauth",
          overview: "./docs/shared.md",
        },
        disabled: {
          url: "https://example.com/oauth",
          auth: "oauth",
        },
        inherited: {
          command: "node",
          args: ["inherited-server.mjs"],
        },
      },
    }, null, 2), "utf8");

    writeFileSync(projectConfigPath, JSON.stringify({
      materialization: {
        summaryItemCount: 5,
      },
      tui: {
        renderMode: "minimal",
      },
      servers: {
        shared: {
          command: "node",
          args: ["project-server.mjs"],
          overview: "./docs/shared.md",
        },
        disabled: null,
        "project-only": {
          command: "node",
          args: ["project-only.mjs"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths(
      [globalConfigPath, projectConfigPath],
      overviewDir,
      artifactDir,
    );

    expect(loaded.configPaths).toEqual([globalConfigPath, projectConfigPath]);
    expect(loaded.materialization).toMatchObject({
      summaryItemCount: 5,
      hardMaxChars: 1000,
    });
    expect(loaded.tui).toMatchObject({
      renderMode: "minimal",
      expandedModeCollapsedLines: 8,
    });
    expect(loaded.servers.map(server => server.name)).toEqual([
      "shared",
      "inherited",
      "project-only",
    ]);

    const shared = loaded.servers.find(server => server.name === "shared");
    expect(shared?.definition).toEqual({
      command: "node",
      args: ["project-server.mjs"],
      overview: projectOverviewPath,
    });
    expect(shared?.overview).toMatchObject({
      source: "config",
      path: projectOverviewPath,
      content: "Project shared overview",
    });
  });
});
