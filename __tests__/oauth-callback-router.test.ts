import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OauthCallbackRouter } from "../extensions/oauth/callback-router.js";

const routers: OauthCallbackRouter[] = [];

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function createRouter(): Promise<OauthCallbackRouter> {
  const port = await findFreePort();
  const router = new OauthCallbackRouter(`http://127.0.0.1:${port}/oauth/callback`);
  routers.push(router);
  return router;
}

afterEach(async () => {
  await Promise.all(routers.splice(0).map(router => router.close()));
});

describe("OauthCallbackRouter", () => {
  it("只接受匹配 state 的一次性 authorization code，且成功页不回显 code", async () => {
    const router = await createRouter();
    const waiter = await router.register();
    const callbackUrl = new URL(router.redirectUrl);
    callbackUrl.searchParams.set("state", waiter.state);
    callbackUrl.searchParams.set("code", "authorization-code-value");

    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("authorization-code-value");
    await expect(waiter.wait()).resolves.toBe("authorization-code-value");

    const reused = await fetch(callbackUrl);
    expect(reused.status).toBe(400);
  });

  it("拒绝 provider 返回的 OAuth error，并且不暴露 error_description", async () => {
    const router = await createRouter();
    const waiter = await router.register();
    const callbackUrl = new URL(router.redirectUrl);
    callbackUrl.searchParams.set("state", waiter.state);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("error_description", "sensitive provider message");

    const response = await fetch(callbackUrl);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("sensitive provider message");
    await expect(waiter.wait()).rejects.toThrow("OAuth authorization failed: access_denied.");
  });

  it("取消或关闭会结束等待 callback 的授权事务", async () => {
    const router = await createRouter();
    const waiter = await router.register();
    waiter.cancel();
    await expect(waiter.wait()).rejects.toThrow("OAuth authorization was cancelled.");

    const nextWaiter = await router.register();
    await router.close();
    await expect(nextWaiter.wait()).rejects.toThrow("OAuth callback router was closed.");
  });

  it("拒绝不安全或不固定的 callback URL", () => {
    expect(() => new OauthCallbackRouter("https://127.0.0.1:33418/oauth/callback")).toThrow(/http:\/\/127\.0\.0\.1/);
    expect(() => new OauthCallbackRouter("http://localhost:33418/oauth/callback")).toThrow(/http:\/\/127\.0\.0\.1/);
    expect(() => new OauthCallbackRouter("http://127.0.0.1:33418/oauth/callback?x=1")).toThrow(/without query/);
  });
});
