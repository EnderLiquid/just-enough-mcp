import { describe, expect, it } from "vitest";
import { makeResolvedServerConfig } from "./support/model-fixtures.js";
import {
  createMcpRegistry,
  RegistryClosedError,
  UnknownServerError,
  type McpRegistry,
} from "../packages/core/src/index.js";

function createRegistry(): McpRegistry {
  return createMcpRegistry([
    makeResolvedServerConfig({
      name: "demo",
      definition: { command: "npx" },
    }),
  ]);
}

describe("McpRegistry 公共契约", () => {
  it("对不存在的 server 返回稳定 UnknownServerError", async () => {
    const registry = createRegistry();

    await expect(registry.getServerSnapshot("missing")).rejects.toBeInstanceOf(UnknownServerError);
    await expect(registry.connectServer("missing")).rejects.toBeInstanceOf(UnknownServerError);
    await expect(registry.getServerCatalog("missing")).rejects.toMatchObject({
      name: "UnknownServerError",
      code: "unknown-server",
      serverName: "missing",
      details: { serverName: "missing" },
    });

    await registry.close();
  });

  it("对不支持 OAuth 的 server 返回稳定 capability error", async () => {
    const registry = createRegistry();

    await expect(registry.authorizeServer("demo")).rejects.toMatchObject({
      name: "UnsupportedServerCapabilityError",
      code: "unsupported-capability",
      capability: "oauth-authorization",
      details: {
        serverName: "demo",
        capability: "oauth-authorization",
      },
    });
    await expect(registry.logoutServer("demo")).rejects.toMatchObject({
      name: "UnsupportedServerCapabilityError",
      code: "unsupported-capability",
      capability: "oauth-logout",
    });

    await registry.close();
  });

  it("关闭后拒绝新操作，并保持 close 幂等", async () => {
    const registry = createRegistry();

    const firstClose = registry.close();
    const secondClose = registry.close();
    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, secondClose]);

    await expect(registry.getStatus()).rejects.toBeInstanceOf(RegistryClosedError);
    await expect(registry.getServerCatalog("demo")).rejects.toMatchObject({
      code: "registry-closed",
      message: "MCP server registry is closed.",
    });
  });

  it("错误可以序列化为稳定的领域错误 JSON", () => {
    const error = new UnknownServerError("missing");

    expect(error.toJSON()).toEqual({
      name: "UnknownServerError",
      code: "unknown-server",
      message: "Unknown MCP server: missing",
      details: { serverName: "missing" },
    });
    expect(JSON.stringify(error)).toBe(JSON.stringify(error.toJSON()));
  });
});
