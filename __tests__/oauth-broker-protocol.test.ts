import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createOAuthBrokerRequestEnvelope,
  createOAuthBrokerSecret,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_PROTOCOL_VERSION,
  parseOAuthBrokerAccessDescriptor,
  parseOAuthBrokerResponseEnvelope,
  type OAuthBrokerAccessDescriptor,
} from "../extensions/oauth/broker/protocol.js";
import {
  ensureOAuthBrokerRuntimeDirectories,
  getOAuthBrokerRuntimePaths,
  readOAuthBrokerAccess,
  writeOAuthBrokerAccess,
} from "../extensions/oauth/broker/runtime-files.js";
import { createOAuthBrokerNamespace } from "../extensions/oauth/broker/namespace.js";
import { requestOAuthBrokerJson } from "../extensions/oauth/broker/client.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker-protocol");

function makeAccess(port = 33418, namespaceId = "agent-dir:v1:" + "a".repeat(64)): OAuthBrokerAccessDescriptor {
  return {
    format: OAUTH_BROKER_ACCESS_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId,
    instanceId: randomUUID(),
    port,
    startedAt: Date.now(),
    secret: createOAuthBrokerSecret(),
  };
}

describe("OAuth broker simplified protocol", () => {
  it("namespace is stable after path canonicalization and isolated between directories", async () => {
    const firstDir = tempDirs.create();
    const secondDir = tempDirs.create();
    const first = await createOAuthBrokerNamespace(`${firstDir}/.`);
    const same = await createOAuthBrokerNamespace(firstDir);
    const second = await createOAuthBrokerNamespace(secondDir);

    expect(same.namespaceId).toBe(first.namespaceId);
    expect(second.namespaceId).not.toBe(first.namespaceId);
    expect(first.namespaceId).toMatch(/^agent-dir:v1:[0-9a-f]{64}$/);
  });

  it("access snapshots are atomically replaceable and stale files remain readable", async () => {
    const rootDir = tempDirs.create();
    await ensureOAuthBrokerRuntimeDirectories(rootDir);
    const first = makeAccess(34101);
    const second = makeAccess(34101, first.namespaceId);
    await writeOAuthBrokerAccess(rootDir, first);
    expect(await readOAuthBrokerAccess(rootDir)).toMatchObject({
      instanceId: first.instanceId,
      secret: first.secret,
    });
    await writeOAuthBrokerAccess(rootDir, second);
    expect(await readOAuthBrokerAccess(rootDir)).toMatchObject({
      instanceId: second.instanceId,
      secret: second.secret,
    });
    expect(await readFile(getOAuthBrokerRuntimePaths(rootDir).accessPath, "utf8")).toContain(second.instanceId);
  });

  it("rejects malformed access snapshots and preserves request correlation", () => {
    expect(() => parseOAuthBrokerAccessDescriptor({
      ...makeAccess(),
      secret: "not-a-secret",
    })).toThrow(/access\.secret/);

    const requestId = randomUUID();
    const envelope = createOAuthBrokerRequestEnvelope(requestId, { ok: true });
    expect(parseOAuthBrokerResponseEnvelope({
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: envelope.params,
    }, requestId)).toMatchObject({ ok: true, requestId });
    expect(() => parseOAuthBrokerResponseEnvelope({
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId: randomUUID(),
      ok: true,
      result: null,
    }, requestId)).toThrow(/requestId/);
  });

  it("maps caller abort and timeout independently at the low-level request boundary", async () => {
    const access = makeAccess(34102);
    const abortController = new AbortController();
    abortController.abort(new Error("caller stopped"));
    await expect(requestOAuthBrokerJson(access, "/v1/test", {
      signal: abortController.signal,
      fetch: async (_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return new Promise<Response>(() => undefined);
      },
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: "broker-request-aborted" });

    await expect(requestOAuthBrokerJson(access, "/v1/test", {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => undefined),
      } as Response),
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: "broker-timeout" });
  });
});
