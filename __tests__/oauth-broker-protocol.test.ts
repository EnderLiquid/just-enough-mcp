import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthBrokerClient } from "../extensions/oauth/broker/client.js";
import { createOAuthBrokerNamespace } from "../extensions/oauth/broker/namespace.js";
import {
  assertOAuthBrokerPublication,
  createOAuthBrokerSecret,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_ENDPOINT_FORMAT,
  OAUTH_BROKER_PROTOCOL_VERSION,
  parseOAuthBrokerResponseEnvelope,
  type OAuthBrokerPublication,
} from "../extensions/oauth/broker/protocol.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-protocol");

afterEach(() => tempDirs.cleanup());

function makePublication(port = 33418): OAuthBrokerPublication {
  const claimId = randomUUID();
  const instanceId = randomUUID();
  const namespaceId = "agent-dir:v1:" + "1".repeat(64);
  return {
    endpoint: {
      format: OAUTH_BROKER_ENDPOINT_FORMAT,
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      namespaceId,
      claimId,
      instanceId,
      pid: process.pid,
      port,
      startedAt: 1,
    },
    access: {
      format: OAUTH_BROKER_ACCESS_FORMAT,
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      namespaceId,
      claimId,
      instanceId,
      secret: createOAuthBrokerSecret(),
    },
  };
}

describe("OAuth broker namespace 与协议", () => {
  it("同一 agentDir 的不同路径写法生成同一 namespace，且不泄露路径", async () => {
    const directory = tempDirs.create();
    const first = await createOAuthBrokerNamespace(directory);
    const second = await createOAuthBrokerNamespace(`${directory}/.`);

    expect(second.namespaceId).toBe(first.namespaceId);
    expect(first.namespaceId).toMatch(/^agent-dir:v1:[0-9a-f]{64}$/);
    expect(first.namespaceId).not.toContain(directory);
  });

  it("不同 agentDir 生成隔离的 namespace", async () => {
    const first = await createOAuthBrokerNamespace(tempDirs.create());
    const second = await createOAuthBrokerNamespace(tempDirs.create());

    expect(second.namespaceId).not.toBe(first.namespaceId);
  });

  it("拒绝 endpoint 与 access 的 instance 不匹配", () => {
    const publication = makePublication();
    expect(() => assertOAuthBrokerPublication({
      endpoint: publication.endpoint,
      access: { ...publication.access, instanceId: randomUUID() },
    })).toThrow("endpoint and access descriptors do not match");
  });

  it("response envelope 必须回显当前 requestId", () => {
    expect(() => parseOAuthBrokerResponseEnvelope({
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId: "another-request",
      ok: true,
      result: {},
    }, "current-request")).toThrow("requestId does not match");
  });
});

describe("OAuthBrokerClient request boundary", () => {
  it("方法级 timeout 与 caller abort 使用不同错误码", async () => {
    const hangingFetch = ((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) {
          rejectAbort();
        } else {
          init?.signal?.addEventListener("abort", rejectAbort, { once: true });
        }
      })) as typeof globalThis.fetch;

    const timeoutClient = new OAuthBrokerClient({
      publication: makePublication(),
      requestTimeoutMs: 15,
      presencePulseMs: 10,
      fetch: hangingFetch,
    });
    await expect(timeoutClient.health()).rejects.toMatchObject({ code: "broker-timeout" });

    const abortClient = new OAuthBrokerClient({
      publication: makePublication(),
      requestTimeoutMs: 1_000,
      presencePulseMs: 10,
      fetch: hangingFetch,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(abortClient.health({ signal: controller.signal })).rejects.toMatchObject({
      code: "broker-request-aborted",
    });
  });

  it("timeout 覆盖收到 response headers 之后的 body 读取", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{\"protocolVersion\":1");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : undefined;
    if (!port) {
      throw new Error("Expected a loopback port.");
    }

    try {
      const client = new OAuthBrokerClient({
        publication: makePublication(port),
        requestTimeoutMs: 25,
      });
      await expect(client.health()).rejects.toMatchObject({ code: "broker-timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("拒绝 requestId 不匹配的成功响应", async () => {
    const mismatchedFetch = (async () => new Response(JSON.stringify({
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId: "wrong-request",
      ok: true,
      result: {},
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
    const client = new OAuthBrokerClient({
      publication: makePublication(),
      fetch: mismatchedFetch,
    });

    await expect(client.health()).rejects.toMatchObject({ code: "broker-protocol-error" });
  });
});
