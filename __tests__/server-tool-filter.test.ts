import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
    transport: unknown = undefined;

    async connect(transport: unknown, options?: unknown) {
      await mocks.connect.call(this, transport, options);
      this.transport = transport;
    }

    listTools(params?: unknown, options?: unknown) {
      return mocks.listTools.call(this, params, options);
    }

    callTool(params: unknown, resultSchema?: unknown, options?: unknown) {
      return mocks.callTool.call(this, params, resultSchema, options);
    }

    getServerVersion() {
      return mocks.getServerVersion.call(this);
    }

    async close() {
      this.transport = undefined;
      await mocks.close.call(this);
    }
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
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("invalidates a closed connection and reconnects on the next call", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const connectionError = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    mocks.callTool.mockRejectedValueOnce(connectionError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(connectionError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(registry.getServerState("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });

    await expect(registry.callTool("demo", "search", {})).resolves.toMatchObject({
      toolName: "search",
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("invalidates the connection when the client transport is already absent", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const notConnectedError = new Error("Not connected");
    mocks.callTool.mockImplementationOnce(function (this: { transport: unknown }) {
      this.transport = undefined;
      throw notConnectedError;
    });

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(notConnectedError);

    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(registry.getServerState("demo")).toMatchObject({
      connectState: "disconnected",
      tools: undefined,
    });
  });

  it.each([
    ["request timeout", new McpError(ErrorCode.RequestTimeout, "Request timed out")],
    ["invalid params", new McpError(ErrorCode.InvalidParams, "Invalid params")],
  ])("keeps the connection after a %s error", async (_label, requestError) => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    mocks.callTool.mockRejectedValueOnce(requestError);

    await expect(registry.callTool("demo", "search", {})).rejects.toBe(requestError);

    expect(registry.getServerState("demo")?.connectState).toBe("connected");
    expect(registry.getServerState("demo")?.tools).toHaveLength(remoteTools.length);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("keeps the connection for a remote business failure", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "remote failure" }],
      isError: true,
    });

    const execution = await registry.callTool("demo", "search", {});

    expect(execution.result.isError).toBe(true);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
    expect(mocks.close).not.toHaveBeenCalled();
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

  it("disconnects idempotently and reconnects on the next catalog request", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    await registry.getServerCatalog("demo");

    const first = await registry.disconnectServer("demo");
    const second = await registry.disconnectServer("demo");

    expect(first).toMatchObject({ connectState: "disconnected", tools: undefined });
    expect(second).toMatchObject({ connectState: "disconnected", tools: undefined });

    await registry.getServerCatalog("demo");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(registry.getServerState("demo")?.connectState).toBe("connected");
  });

  it("rejects disconnect while the server is connecting", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));
    const controller = new AbortController();
    const abortReason = new Error("cancelled by user");
    mocks.connect.mockImplementationOnce((
      _transport: unknown,
      options: { signal?: AbortSignal } | undefined,
    ) => rejectWhenAborted(options));

    const connecting = registry.connectServer("demo", controller.signal);
    await vi.waitFor(() => {
      expect(registry.getServerState("demo")?.connectState).toBe("connecting");
    });

    await expect(registry.disconnectServer("demo")).rejects.toThrow(
      'Cannot disconnect MCP server "demo" while it is connecting. Cancel the in-flight operation first.',
    );

    controller.abort(abortReason);
    await expect(connecting).rejects.toBe(abortReason);
    expect(registry.getServerState("demo")?.connectState).toBe("disconnected");
  });

  it("rejects disconnect for an unknown server", async () => {
    const registry = createServerRegistry();
    await registry.syncConfig(makeConfig({}));

    await expect(registry.disconnectServer("missing")).rejects.toThrow("Unknown MCP server: missing");
  });

  it("rejects invalid tool filter configuration", async () => {
    const registry = createServerRegistry();

    await expect(registry.syncConfig(makeConfig({ includeTools: ["search", ""] }))).rejects.toThrow(/includeTools/);
    await expect(registry.syncConfig(makeConfig({ excludeTools: "write" }))).rejects.toThrow(/excludeTools/);
  });
});
