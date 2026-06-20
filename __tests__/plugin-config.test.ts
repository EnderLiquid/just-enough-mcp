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
  it("parses stdio and http servers with connection modes", () => {
    const root = makeTempDir();
    const configPath = join(root, "just-enough-mcp.json");
    const overviewDir = join(root, "mcp-overview");
    mkdirSync(overviewDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({
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

    expect(tavily?.transport).toBe("http");
    expect(tavily?.connectionMode).toBe("eager");
    expect(localTools?.transport).toBe("stdio");
    expect(localTools?.connectionMode).toBe("lazy");
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
});
