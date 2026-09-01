import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OauthCredentialStore, type OauthCredentialIdentity } from "../extensions/oauth/credential-store.js";

const cleanupPaths: string[] = [];

async function createStore(): Promise<{ store: OauthCredentialStore; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "just-enough-mcp-oauth-"));
  cleanupPaths.push(directory);
  const filePath = join(directory, "oauth", "credentials.json");
  return { store: new OauthCredentialStore(filePath), filePath };
}

const identity: OauthCredentialIdentity = {
  serverName: "demo",
  serverUrl: "https://example.com/mcp",
};

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("OauthCredentialStore", () => {
  it("为同一 server identity 一起保存 DCR client information 和轮换后的 tokens", async () => {
    const { store, filePath } = await createStore();
    await store.saveClientInformation(identity, {
      client_id: "registered-client",
      client_secret: "registered-secret",
      token_endpoint_auth_method: "client_secret_basic",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    });
    await store.saveTokens(identity, {
      access_token: "access-one",
      refresh_token: "refresh-one",
      token_type: "Bearer",
    });
    await store.saveTokens(identity, {
      access_token: "access-two",
      refresh_token: "refresh-two",
      token_type: "Bearer",
    });

    await expect(store.read(identity)).resolves.toEqual({
      serverUrl: "https://example.com/mcp",
      clientInformation: {
        client_id: "registered-client",
        client_secret: "registered-secret",
        token_endpoint_auth_method: "client_secret_basic",
        redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      },
      tokens: {
        access_token: "access-two",
        refresh_token: "refresh-two",
        token_type: "Bearer",
      },
    });
    expect(await readFile(filePath, "utf8")).toContain("access-two");

    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o077).toBe(0);
    }
  });

  it("在 config identity 变化时不复用其他 MCP resource 的 records", async () => {
    const { store } = await createStore();
    await store.saveTokens(identity, {
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });

    await expect(store.read({ ...identity, serverUrl: "https://other.example/mcp" })).resolves.toBeUndefined();
    await expect(store.read({ ...identity, clientMetadataUrl: "https://example.com/client.json" })).resolves.toBeUndefined();
  });

  it("可分别清除 tokens 和完整本地 OAuth record", async () => {
    const { store } = await createStore();
    await store.saveClientInformation(identity, { client_id: "registered-client" });
    await store.saveTokens(identity, { access_token: "access-token", token_type: "Bearer" });

    await store.clearTokens(identity);
    await expect(store.read(identity)).resolves.toEqual({
      serverUrl: "https://example.com/mcp",
      clientInformation: { client_id: "registered-client" },
    });

    await store.clearAll(identity);
    await expect(store.read(identity)).resolves.toBeUndefined();
  });

  it("不静默覆盖格式损坏的 credential file", async () => {
    const { store, filePath } = await createStore();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "not json", "utf8");

    await expect(store.read(identity)).rejects.toThrow("OAuth credential file is not valid JSON");
  });
});
