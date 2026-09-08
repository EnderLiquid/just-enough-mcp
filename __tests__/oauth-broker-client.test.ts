import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OAuthBrokerClient,
} from "../extensions/oauth/broker/client.js";
import {
  createOAuthBrokerSuccessEnvelope,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerHealth,
} from "../extensions/oauth/broker/protocol.js";
import { writeOAuthBrokerAccess } from "../extensions/oauth/broker/runtime-files.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker-client");

function createFixture(): {
  rootDir: string;
  access: OAuthBrokerAccessDescriptor;
  health: OAuthBrokerHealth;
} {
  const rootDir = tempDirs.create();
  const access: OAuthBrokerAccessDescriptor = {
    format: OAUTH_BROKER_ACCESS_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId: "agent-dir:v1:" + "f".repeat(64),
    instanceId: randomUUID(),
    port: 33418,
    startedAt: Date.now(),
    secret: "a".repeat(64),
  };
  return {
    rootDir,
    access,
    health: {
      namespaceId: access.namespaceId,
      instanceId: access.instanceId,
      pid: 12345,
      port: access.port,
      startedAt: access.startedAt,
      presenceCount: 1,
      pendingOperationCount: 0,
      idleDeadline: null,
    },
  };
}

function parsePresenceAction(init: RequestInit | undefined): string | undefined {
  if (typeof init?.body !== "string") {
    return undefined;
  }
  const value = JSON.parse(init.body) as { params?: { action?: string } };
  return value.params?.action;
}

function successResponse(init: RequestInit | undefined, health: OAuthBrokerHealth): Response {
  const requestId = new Headers(init?.headers).get(OAUTH_BROKER_REQUEST_ID_HEADER);
  if (!requestId) {
    throw new Error("Missing request ID.");
  }
  return new Response(JSON.stringify(createOAuthBrokerSuccessEnvelope(requestId, health)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("OAuthBrokerClient lifecycle concurrency", () => {
  it("shares one connection flight and caller abort does not cancel other waiters", async () => {
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    const registerGate = deferred();
    let registerCalls = 0;
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      if (parsePresenceAction(init) === "register") {
        registerCalls += 1;
        await registerGate.promise;
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
      reconnectIntervalMs: 5_000,
      presencePulseMs: 5_000,
      fetch,
    });

    client.start();
    const survivor = client.ensureConnected();
    const controller = new AbortController();
    const cancelled = client.ensureConnected({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "broker-request-aborted" });
    registerGate.resolve();
    await survivor;

    expect(registerCalls).toBe(1);
    expect(client.state).toBe("connected");
    await client.close();
  });

  it("freeze invalidates a late register and releases its presence incarnation", async () => {
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    const registerGate = deferred();
    const registerStarted = deferred();
    let releaseCalls = 0;
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      const action = parsePresenceAction(init);
      if (action === "register") {
        registerStarted.resolve();
        await registerGate.promise;
      } else if (action === "release") {
        releaseCalls += 1;
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
      reconnectIntervalMs: 5_000,
      presencePulseMs: 5_000,
      fetch,
    });

    client.start();
    await registerStarted.promise;
    await client.freeze();
    expect(client.state).toBe("frozen");
    registerGate.resolve();
    await waitFor(() => releaseCalls === 1, 1_000);

    expect(client.state).toBe("frozen");
    expect(client.currentPresenceId).toBeUndefined();
    await client.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
