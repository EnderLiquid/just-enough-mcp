import { describe, expect, it } from "vitest";
import type { ResolvedServerConfig, ServerDefinition } from "../extensions/modeling/types.js";
import { createMcpServer, resolveCompatibilityProfile } from "../extensions/servers/servers/factory.js";

function makeConfig(definition: ServerDefinition, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "demo",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: {
      name: "demo",
      content: "No overview configured yet.",
      source: "none",
    },
    definition,
    ...overrides,
  };
}

describe("createMcpServer", () => {
  it("infers stdio pragmatic profile from command when transport is omitted", () => {
    const config = makeConfig({ command: "npx" });

    expect(resolveCompatibilityProfile(config)).toBe("stdio-tools-pragmatic");
    expect(createMcpServer(config).snapshot()).toMatchObject({
      name: "demo",
      profile: "stdio-tools-pragmatic",
      connectState: "disconnected",
    });
  });

  it("infers public HTTP profile from url when transport is omitted", () => {
    const config = makeConfig({ url: "https://example.com/mcp" });

    expect(resolveCompatibilityProfile(config)).toBe("http-tools-public");
    expect(createMcpServer(config).snapshot()).toMatchObject({
      name: "demo",
      profile: "http-tools-public",
      connectState: "disconnected",
    });
  });

  it("keeps explicit legacy transport as the primary hint", () => {
    expect(resolveCompatibilityProfile(makeConfig({
      transport: "stdio",
      command: "npx",
      url: "https://example.com/mcp",
    }))).toBe("stdio-tools-pragmatic");

    expect(resolveCompatibilityProfile(makeConfig({
      transport: "http",
      command: "npx",
      url: "https://example.com/mcp",
    }))).toBe("http-tools-public");
  });

  it("infers token HTTP profile from bearer token or headers", () => {
    expect(resolveCompatibilityProfile(makeConfig({
      url: "https://example.com/mcp",
      bearerToken: "token-123",
    }))).toBe("http-tools-token");

    expect(resolveCompatibilityProfile(makeConfig({
      url: "https://example.com/mcp",
      headers: { "X-API-Key": "secret" },
    }))).toBe("http-tools-token");
  });

  it("validates concrete server fields after profile dispatch", () => {
    expect(() => createMcpServer(makeConfig({ transport: "stdio" }))).toThrow(/demo.*command/);
    expect(() => createMcpServer(makeConfig({ transport: "http" }))).toThrow(/demo.*url/);
    expect(() => createMcpServer(makeConfig({ transport: "websocket" }))).toThrow(/stdio.*http/);
    expect(() => createMcpServer(makeConfig({ command: "npx", url: "https://example.com/mcp" }))).toThrow(/demo.*both command and url/);
    expect(() => createMcpServer(makeConfig({}))).toThrow(/demo.*command or url/);
  });
});
