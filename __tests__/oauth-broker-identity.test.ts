import { describe, expect, it } from "vitest";
import {
  createOAuthIdentity,
  createRequestHeadersDigest,
  parseOAuthIdentity,
} from "../packages/core/src/oauth/broker/identity.js";

describe("OAuth identity v1", () => {
  it("以稳定的 canonical 字段生成 identity，并默认 profile", () => {
    const first = createOAuthIdentity({
      namespaceId: "agent-dir-a",
      resourceUrl: "https://MCP.example.com:443/mcp",
      clientMetadataUrl: "https://AUTH.example.com:443/client",
      requestHeaders: {
        "X-Tenant": "demo",
        Accept: "application/json",
      },
    });
    const equivalent = createOAuthIdentity({
      namespaceId: "agent-dir-a",
      resourceUrl: new URL("https://mcp.example.com/mcp"),
      clientMetadataUrl: "https://auth.example.com/client",
      profile: "default",
      requestHeaders: {
        accept: "application/json",
        "x-tenant": "demo",
      },
    });

    expect(first).toEqual(equivalent);
    expect(first).toMatchObject({
      identityVersion: 1,
      namespaceId: "agent-dir-a",
      resourceUrl: "https://mcp.example.com/mcp",
      clientMetadataUrl: "https://auth.example.com/client",
      clientName: "just-enough-mcp",
      profile: "default",
    });
    expect(first.requestHeadersDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.key).toMatch(/^oauth:v1:[0-9a-f]{64}$/);
  });

  it("将 header 名按 HTTP 大小写不敏感规则纳入摘要，但保留值差异", () => {
    const first = createRequestHeadersDigest({ "X-Tenant": "demo" });
    const equivalent = createRequestHeadersDigest({ "x-tenant": "demo" });
    const different = createRequestHeadersDigest({ "x-tenant": "other" });

    expect(first).toBe(equivalent);
    expect(first).not.toBe(different);
    expect(first).not.toContain("demo");
  });

  it.each([
    ["namespaceId", { namespaceId: " " }],
    ["resourceUrl", { resourceUrl: "not-a-url" }],
    ["resourceUrl protocol", { resourceUrl: "file:///tmp/mcp" }],
    ["clientMetadataUrl", { clientMetadataUrl: "not-a-url" }],
    ["clientMetadataUrl protocol", { clientMetadataUrl: "http://example.com/client" }],
    ["clientName type", { clientName: 42 as unknown as string }],
    ["clientName blank", { clientName: "   " }],
    ["clientName control character", { clientName: "bad\u0007name" }],
    ["clientName length", { clientName: "a".repeat(257) }],
    ["profile", { profile: " " }],
  ])("拒绝无效的 %s", (_label, override) => {
    expect(() => createOAuthIdentity({
      namespaceId: "agent-dir-a",
      resourceUrl: "https://example.com/mcp",
      ...override,
    })).toThrow(TypeError);
  });

  it("拒绝可能导致 identity 歧义的重复 header 名", () => {
    expect(() => createOAuthIdentity({
      namespaceId: "agent-dir-a",
      resourceUrl: "https://example.com/mcp",
      requestHeaders: {
        "X-Tenant": "demo",
        "x-tenant": "demo",
      },
    })).toThrow(/duplicate case-insensitive header/);
  });

  it("未配置与显式默认 clientName 等价，自定义名称隔离到不同 identity", () => {
    const base = {
      namespaceId: "agent-dir-a",
      resourceUrl: "https://example.com/mcp",
    } as const;
    const unconfigured = createOAuthIdentity(base);
    const explicitDefault = createOAuthIdentity({ ...base, clientName: "just-enough-mcp" });
    const custom = createOAuthIdentity({ ...base, clientName: "  Custom Client  " });

    expect(explicitDefault).toEqual(unconfigured);
    expect(custom.clientName).toBe("Custom Client");
    expect(custom.key).not.toBe(unconfigured.key);
  });

  it("parseOAuthIdentity 接受规范 identity，并拒绝缺失或非法的 clientName", () => {
    const identity = createOAuthIdentity({
      namespaceId: "agent-dir-a",
      resourceUrl: "https://example.com/mcp",
      clientName: "Custom Client",
    });

    expect(parseOAuthIdentity(identity)).toEqual(identity);
    expect(() => parseOAuthIdentity({ ...identity, clientName: undefined })).toThrow(TypeError);
    expect(() => parseOAuthIdentity({ ...identity, clientName: "   " })).toThrow(TypeError);
  });

  it("将 namespace、profile、metadata URL、clientName 和 header 值的变化隔离到不同 identity", () => {
    const base = {
      namespaceId: "agent-dir-a",
      resourceUrl: "https://example.com/mcp",
      clientMetadataUrl: "https://example.com/client",
      profile: "default",
      requestHeaders: { "X-Tenant": "demo" },
    } as const;
    const identity = createOAuthIdentity(base);

    expect(createOAuthIdentity({ ...base, namespaceId: "agent-dir-b" }).key).not.toBe(identity.key);
    expect(createOAuthIdentity({ ...base, profile: "work" }).key).not.toBe(identity.key);
    expect(createOAuthIdentity({ ...base, clientMetadataUrl: null }).key).not.toBe(identity.key);
    expect(createOAuthIdentity({ ...base, clientName: "Custom Client" }).key).not.toBe(identity.key);
    expect(createOAuthIdentity({
      ...base,
      requestHeaders: { "X-Tenant": "other" },
    }).key).not.toBe(identity.key);
  });
});
