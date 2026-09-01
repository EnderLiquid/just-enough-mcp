import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { OauthCallbackRouter } from "../extensions/oauth/callback-router.js";
import { OauthCredentialStore } from "../extensions/oauth/credential-store.js";
import { McpOauthClientProvider } from "../extensions/oauth/mcp-oauth-client-provider.js";

const closers: Array<() => Promise<void>> = [];

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${address.port}`;
}

async function reserveCallbackUrl(): Promise<string> {
  const server = createServer();
  const base = await listen(server);
  await closers.pop()!();
  return `${base}/oauth/callback`;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
});

describe("MCP SDK OAuth integration", () => {
  it("用实际 SDK 完成 PRM discovery、DCR、PKCE redirect 和 authorization-code exchange", async () => {
    const registrations: Array<Record<string, unknown>> = [];
    const tokenRequests: URLSearchParams[] = [];
    let authorizationUrl: URL | undefined;
    let baseUrl = "";
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", baseUrl);
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        sendJson(response, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(response, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/register") {
        registrations.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
        sendJson(response, {
          client_id: "dynamic-client",
          redirect_uris: registrations[0]?.redirect_uris,
          token_endpoint_auth_method: "none",
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        tokenRequests.push(new URLSearchParams(await readBody(request)));
        const tokenIndex = tokenRequests.length;
        sendJson(response, {
          access_token: `access-token-${tokenIndex}`,
          refresh_token: `refresh-token-${tokenIndex}`,
          token_type: "Bearer",
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    baseUrl = await listen(server);

    const credentialDirectory = await mkdtemp(join(tmpdir(), "just-enough-mcp-oauth-sdk-"));
    closers.push(() => rm(credentialDirectory, { recursive: true, force: true }));
    const callbackRouter = new OauthCallbackRouter(await reserveCallbackUrl());
    closers.push(() => callbackRouter.close());
    const credentialStore = new OauthCredentialStore(join(credentialDirectory, "credentials.json"));
    const provider = new McpOauthClientProvider({
      serverName: "demo",
      identity: { serverName: "demo", serverUrl: `${baseUrl}/mcp` },
      callbackRouter,
      credentialStore,
      openAuthorizationUrl: async url => {
        authorizationUrl = new URL(url);
        const callbackUrl = new URL(callbackRouter.redirectUrl);
        callbackUrl.searchParams.set("code", "authorization-code");
        callbackUrl.searchParams.set("state", url.searchParams.get("state")!);
        void fetch(callbackUrl).catch(() => {});
      },
    });

    provider.beginInteractiveAuthorization();
    await expect(auth(provider, { serverUrl: `${baseUrl}/mcp` })).resolves.toBe("REDIRECT");
    const code = await provider.waitForAuthorizationCode();
    await expect(auth(provider, {
      serverUrl: `${baseUrl}/mcp`,
      authorizationCode: code,
    })).resolves.toBe("AUTHORIZED");
    await expect(auth(provider, { serverUrl: `${baseUrl}/mcp` })).resolves.toBe("AUTHORIZED");

    expect(registrations).toEqual([expect.objectContaining({
      redirect_uris: [callbackRouter.redirectUrl],
      client_name: "just-enough-mcp",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })]);
    expect(authorizationUrl?.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("resource")).toBe(`${baseUrl}/mcp`);
    expect(authorizationUrl?.searchParams.get("redirect_uri")).toBe(callbackRouter.redirectUrl);
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0]?.get("code")).toBe("authorization-code");
    expect(tokenRequests[0]?.get("resource")).toBe(`${baseUrl}/mcp`);
    expect(tokenRequests[1]?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[1]?.get("refresh_token")).toBe("refresh-token-1");
    expect(tokenRequests[1]?.get("resource")).toBe(`${baseUrl}/mcp`);
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "access-token-2",
      refresh_token: "refresh-token-2",
    });
  });
});
