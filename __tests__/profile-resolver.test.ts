import { describe, expect, it } from "vitest";
import type { ConfiguredServerConfig } from "../extensions/modeling/types.js";
import { resolveInitialProfileId } from "../extensions/clients/profiles/resolver.js";

describe("resolveInitialProfileId", () => {
  it("classifies stdio servers as stdio-tools-pragmatic", () => {
    const profileId = resolveInitialProfileId({
      transport: "stdio",
      command: "npx",
      connectionMode: "lazy",
    } as ConfiguredServerConfig);

    expect(profileId).toBe("stdio-tools-pragmatic");
  });

  it("classifies unauthenticated http servers as http-tools-public", () => {
    const profileId = resolveInitialProfileId({
      transport: "http",
      url: "https://example.com/mcp",
      connectionMode: "lazy",
    } as ConfiguredServerConfig);

    expect(profileId).toBe("http-tools-public");
  });

  it("classifies static-auth http servers as http-tools-token", () => {
    const profileId = resolveInitialProfileId({
      transport: "http",
      url: "https://example.com/mcp",
      bearerToken: "token-123",
      connectionMode: "lazy",
    } as ConfiguredServerConfig);

    expect(profileId).toBe("http-tools-token");
  });
});
