import { afterEach, describe, expect, it } from "vitest";
import {
  getCurrentPluginConfig,
  installCurrentPluginConfig,
  requireCurrentPluginConfig,
} from "../extensions/config/current-config.js";
import {
  getCurrentServerRegistry,
  installCurrentServerRegistry,
  requireCurrentServerRegistry,
} from "../extensions/servers/current-registry.js";
import type { ServerRegistry } from "../extensions/servers/registry.js";
import { makePluginConfig } from "./support/model-fixtures.js";

const disposers: Array<() => void> = [];

function makeRegistry(): ServerRegistry {
  return {
    initialize: async () => {},
    getStatus: async () => ({ servers: [], connectedCount: 0, totalCount: 0 }),
    getServerSnapshot: async () => undefined,
    connectServer: async () => { throw new Error("unused"); },
    disconnectServer: async () => { throw new Error("unused"); },
    authorizeServer: async () => { throw new Error("unused"); },
    logoutServer: async () => { throw new Error("unused"); },
    getServerCatalog: async () => { throw new Error("unused"); },
    callTool: async () => { throw new Error("unused"); },
    closeAll: async () => {},
  };
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
});

describe("current plugin references", () => {
  it("安装并按身份清理 config", () => {
    const first = makePluginConfig({ configPaths: ["first.json"] });
    const second = makePluginConfig({ configPaths: ["second.json"] });
    const disposeFirst = installCurrentPluginConfig(first);
    disposers.push(disposeFirst);
    const disposeSecond = installCurrentPluginConfig(second);
    disposers.push(disposeSecond);

    disposeFirst();
    expect(getCurrentPluginConfig()).toBe(second);

    disposeSecond();
    expect(getCurrentPluginConfig()).toBeUndefined();
    expect(first.configPaths).toEqual(["first.json"]);
  });

  it("安装并按身份清理 Registry", () => {
    const first = makeRegistry();
    const second = makeRegistry();
    const disposeFirst = installCurrentServerRegistry(first);
    disposers.push(disposeFirst);
    const disposeSecond = installCurrentServerRegistry(second);
    disposers.push(disposeSecond);

    disposeFirst();
    expect(getCurrentServerRegistry()).toBe(second);

    disposeSecond();
    expect(getCurrentServerRegistry()).toBeUndefined();
  });

  it("inactive 时 require accessor 给出明确错误", () => {
    expect(() => requireCurrentPluginConfig()).toThrow(
      "just-enough-mcp is not initialized for the current session",
    );
    expect(() => requireCurrentServerRegistry()).toThrow(
      "just-enough-mcp is not initialized for the current session",
    );
  });
});
