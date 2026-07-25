import { describe, expect, it } from "vitest";
import type { ResolvedServerConfig, ServerDefinition } from "../extensions/modeling/types.js";
import { createMcpServer } from "../extensions/servers/servers/factory.js";
import { HttpPublicServer } from "../extensions/servers/servers/http-public-server.js";
import { HttpTokenServer } from "../extensions/servers/servers/http-token-server.js";
import { StdioPragmaticServer } from "../extensions/servers/servers/stdio-pragmatic-server.js";

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
  it("creates a server from an inferred stdio definition", () => {
    const server = createMcpServer(makeConfig({ command: "npx" }));

    expect(server).toBeInstanceOf(StdioPragmaticServer);
    expect(server.snapshot()).toEqual({
      name: "demo",
      connectState: "disconnected",
      tools: undefined,
    });
  });

  it("creates a public HTTP server without static authentication", () => {
    const server = createMcpServer(makeConfig({ url: "https://example.com/mcp" }));

    expect(server).toBeInstanceOf(HttpPublicServer);
  });

  it.each([
    { url: "https://example.com/mcp", bearerToken: "token-123" },
    { url: "https://example.com/mcp", headers: { "X-API-Key": "secret" } },
  ])("creates a static-token HTTP server for %o", definition => {
    const server = createMcpServer(makeConfig(definition));

    expect(server).toBeInstanceOf(HttpTokenServer);
  });

  it("keeps explicit legacy transport as the primary hint", () => {
    expect(() => createMcpServer(makeConfig({
      transport: "stdio",
      command: "npx",
      url: "https://example.com/mcp",
    }))).not.toThrow();

    expect(() => createMcpServer(makeConfig({
      transport: "http",
      command: "npx",
      url: "https://example.com/mcp",
    }))).not.toThrow();
  });

  it("validates concrete server fields after transport dispatch", () => {
    expect(() => createMcpServer(makeConfig({ transport: "stdio" }))).toThrow(/demo.*command/);
    expect(() => createMcpServer(makeConfig({ transport: "http" }))).toThrow(/demo.*url/);
    expect(() => createMcpServer(makeConfig({ transport: "websocket" }))).toThrow(/stdio.*http/);
    expect(() => createMcpServer(makeConfig({ command: "npx", url: "https://example.com/mcp" }))).toThrow(/demo.*both command and url/);
    expect(() => createMcpServer(makeConfig({}))).toThrow(/demo.*command or url/);
  });
});
