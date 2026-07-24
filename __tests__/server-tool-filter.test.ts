import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedServerConfig } from "../extensions/modeling/types.js";
import { makePluginConfig, makeResolvedServerConfig } from "./support/model-fixtures.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  getServerVersion: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    getServerVersion = mocks.getServerVersion;
    close = mocks.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    close = mocks.transportClose;
    constructor(_options: unknown) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    close = mocks.transportClose;
    constructor(_url: URL, _options?: unknown) {}
  },
}));

import { createServerRegistry } from "../extensions/servers/registry.js";

function makeServer(definition: Record<string, unknown>): ResolvedServerConfig {
  return makeResolvedServerConfig({
    definition: {
      command: "npx",
      ...definition,
    },
  });
}

function makeConfig(definition: Record<string, unknown>) {
  return makePluginConfig({
    servers: [makeServer(definition)],
  });
}

function rejectWhenAborted(options: { signal?: AbortSignal } | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const signal = options?.signal;
    if (!signal) {
      reject(new Error("AbortSignal was not forwarded."));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const remoteTools = [
  { name: "search", description: "Search" },
  { name: "read", description: "Read" },
  { name: "write", description: "Write" },
];

describe("SDK-backed server tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: remoteTools });
    mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.getServerVersion.mockReturnValue({ name: "demo", version: "1.0.0" });
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("limits the catalog to includeTools when configured", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search", "read"] }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search", "read"]);
    expect(registry.getServerState("demo")?.tools?.map(tool => tool.name)).toEqual(["search", "read"]);
  });

  it("applies excludeTools after includeTools", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({
      includeTools: ["search", "read"],
      excludeTools: ["read", "write"],
    }));

    const catalog = await registry.getServerCatalog("demo");

    expect(catalog.tools.map(tool => tool.name)).toEqual(["search"]);
  });

  it("forwards AbortSignal while initializing the MCP client", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled during initialization");
    mocks.connect.mockImplementationOnce((
      _transport: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.getServerCatalog("demo", controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(mocks.listTools).not.toHaveBeenCalled();
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("forwards AbortSignal while loading the tools catalog", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled while loading tools");
    mocks.listTools.mockImplementationOnce((
      _params: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.getServerCatalog("demo", controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("forwards AbortSignal to the SDK request and propagates cancellation", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    mocks.callTool.mockImplementationOnce((
      _params: unknown,
      _resultSchema: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const pending = registry.callTool("demo", "search", { query: "pi" }, controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mocks.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(mocks.listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "pi" } },
      undefined,
      { signal: controller.signal },
    );
  });

  it("rejects direct calls to tools hidden by filters", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ excludeTools: ["write"] }));

    await expect(registry.callTool("demo", "write", {})).rejects.toThrow(/Tool "write" is excluded by configuration/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("keeps a distinct error for unknown remote tools", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({ includeTools: ["search"] }));

    await expect(registry.callTool("demo", "read", {})).rejects.toThrow(/Tool "read" is excluded by configuration/);
    await expect(registry.callTool("demo", "missing", {})).rejects.toThrow(/Tool "missing" is not available/);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid tool filter configuration", async () => {
    const registry = createServerRegistry();

    await expect(registry.syncConfig(makeConfig({ includeTools: ["search", ""] }))).rejects.toThrow(/includeTools/);
    await expect(registry.syncConfig(makeConfig({ excludeTools: "write" }))).rejects.toThrow(/excludeTools/);
  });
});
