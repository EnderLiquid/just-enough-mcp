import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig, ServerSnapshot } from "../extensions/modeling/types.js";
import type { OauthSessionServices } from "../extensions/oauth/session-services.js";
import type { McpServer } from "../extensions/servers/servers/types.js";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  createOauthSessionServices: vi.fn(),
  oauthServicesClose: vi.fn(),
  createMcpServer: vi.fn(),
}));

vi.mock("../extensions/oauth/session-services.js", () => ({
  createOauthSessionServices: mocks.createOauthSessionServices,
}));

vi.mock("../extensions/servers/servers/factory.js", () => ({
  createMcpServer: mocks.createMcpServer,
}));

import { createServerRegistry } from "../extensions/servers/registry.js";

function snapshot(config: ResolvedServerConfig): ServerSnapshot {
  return {
    name: config.name,
    connectState: "disconnected",
  };
}

function makeServer(
  config: ResolvedServerConfig,
  close: McpServer["close"] = async () => snapshot(config),
): McpServer {
  return {
    name: config.name,
    config,
    snapshot: () => snapshot(config),
    connect: async () => snapshot(config),
    getCatalog: async () => ({ server: snapshot(config), tools: [] }),
    callTool: async (toolName, args) => ({
      server: snapshot(config),
      toolName,
      args,
      result: { content: [] },
    }),
    close,
  };
}

describe("ServerRegistry OAuth session services 生命周期", () => {
  let oauthServices: OauthSessionServices;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.oauthServicesClose.mockResolvedValue(undefined);
    oauthServices = { close: mocks.oauthServicesClose } as unknown as OauthSessionServices;
    mocks.createOauthSessionServices.mockReturnValue(oauthServices);
    mocks.createMcpServer.mockImplementation((config: ResolvedServerConfig) => makeServer(config));
  });

  it("为整个 Registry 创建一次 service，并传给每个 server 的组装过程", () => {
    const first = makeResolvedServerConfig({ name: "plain", definition: { command: "npx" } });
    const second = makeResolvedServerConfig({
      name: "oauth",
      definition: { transport: "http", url: "https://example.com/mcp", auth: "oauth" },
    });

    createServerRegistry([first, second]);

    expect(mocks.createOauthSessionServices).toHaveBeenCalledTimes(1);
    expect(mocks.createOauthSessionServices).toHaveBeenCalledWith({
      credentialFilePath: expect.any(String),
    });
    expect(mocks.createMcpServer).toHaveBeenNthCalledWith(1, first, oauthServices);
    expect(mocks.createMcpServer).toHaveBeenNthCalledWith(2, second, oauthServices);
  });

  it("关闭所有 server 后才关闭共享 service", async () => {
    const first = makeResolvedServerConfig({ name: "first", definition: { command: "npx" } });
    const second = makeResolvedServerConfig({ name: "second", definition: { command: "npx" } });
    const firstClose = vi.fn().mockResolvedValue(snapshot(first));
    const secondClose = vi.fn().mockResolvedValue(snapshot(second));
    mocks.createMcpServer
      .mockImplementationOnce((config: ResolvedServerConfig) => makeServer(config, firstClose))
      .mockImplementationOnce((config: ResolvedServerConfig) => makeServer(config, secondClose));
    const registry = createServerRegistry([first, second]);

    await registry.closeAll();

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(mocks.oauthServicesClose).toHaveBeenCalledTimes(1);
    expect(firstClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.oauthServicesClose.mock.invocationCallOrder[0],
    );
    expect(secondClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.oauthServicesClose.mock.invocationCallOrder[0],
    );
  });

  it("server 组装失败时关闭尚未交付给 root 的 service", () => {
    const failure = new Error("invalid server config");
    mocks.createMcpServer.mockImplementationOnce(() => {
      throw failure;
    });
    const config = makeResolvedServerConfig({ definition: { command: "npx" } });

    expect(() => createServerRegistry([config])).toThrow(failure);
    expect(mocks.oauthServicesClose).toHaveBeenCalledTimes(1);
  });
});
