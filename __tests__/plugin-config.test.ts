import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPluginConfigFromPaths } from "../extensions/config/plugin-config.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `jem-config-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadPluginConfigFromPaths", () => {
  it("parses stdio and http servers with connection modes and result presentation settings", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });
    writeFileSync(join(overviewDir, "tavily.md"), "Search and extract web content.\nUse it for latest info.\n", "utf8");

    writeFileSync(configPath, JSON.stringify({
      resultPresentation: {
        summaryItemCount: 3,
        previewLinesPerItem: 2,
        previewCharsPerItem: 120,
        hardMaxChars: 5000,
        collapsedPreviewLines: 5,
        prettyPrintJson: false,
        artifactRoot: "custom-artifacts"
      },
      servers: {
        tavily: {
          transport: "http",
          url: "https://example.com/mcp",
          bearerToken: "token-123",
          connectionMode: "eager",
        },
        localTools: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "some-server"],
        },
      },
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths(configPath, overviewDir);
    expect(loaded.servers).toHaveLength(2);

    const tavily = loaded.servers.find(server => server.name === "tavily");
    const localTools = loaded.servers.find(server => server.name === "localTools");

    expect(loaded.resultPresentation.summaryItemCount).toBe(3);
    expect(loaded.resultPresentation.previewLinesPerItem).toBe(2);
    expect(loaded.resultPresentation.previewCharsPerItem).toBe(120);
    expect(loaded.resultPresentation.hardMaxChars).toBe(5000);
    expect(loaded.resultPresentation.collapsedPreviewLines).toBe(5);
    expect(loaded.resultPresentation.prettyPrintJson).toBe(false);
    expect(loaded.resultPresentation.artifactRoot).toBe("custom-artifacts");
    expect(tavily?.transport).toBe("http");
    expect(tavily?.connectionMode).toBe("eager");
    expect(tavily?.overview.content).toContain("Search and extract web content.");
    expect(localTools?.transport).toBe("stdio");
    expect(localTools?.connectionMode).toBe("lazy");
  });

  it("uses the updated default result presentation settings when omitted", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        localTools: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "some-server"]
        }
      }
    }, null, 2), "utf8");

    const loaded = loadPluginConfigFromPaths(configPath, overviewDir);

    expect(loaded.resultPresentation.previewLinesPerItem).toBe(12);
    expect(loaded.resultPresentation.previewCharsPerItem).toBe(800);
  });

  it("rejects invalid server configuration", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      servers: {
        broken: {
          transport: "stdio",
          args: ["missing-command"],
        },
      },
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/broken/);
  });

  it("rejects invalid result presentation settings", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
      resultPresentation: {
        summaryItemCount: 0,
      },
      servers: {},
    }, null, 2), "utf8");

    expect(() => loadPluginConfigFromPaths(configPath, overviewDir)).toThrow(/resultPresentation.summaryItemCount/);
  });
});
