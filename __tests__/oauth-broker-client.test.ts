import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthBrokerClient,
} from "../packages/core/src/oauth/broker/client.js";
import {
  createOAuthBrokerSuccessEnvelope,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_PRESENCE_ID_HEADER,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_SESSION_ID_HEADER,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerHealth,
} from "../packages/core/src/oauth/broker/protocol.js";
import { writeOAuthBrokerAccess } from "../packages/core/src/oauth/broker/runtime-files.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker-client");

afterEach(() => {
  vi.useRealTimers();
});

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
  it("starts disconnected and supports demand-driven connection", async () => {
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
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

    expect(client.state).toBe("disconnected");
    await client.ensureConnected();
    expect(client.state).toBe("connected");
    await client.close();
  });

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

  it("schedules an idle pulse directly at the activity deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    const actions: string[] = [];
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      const action = parsePresenceAction(init);
      if (action) {
        actions.push(action);
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 500,
      connectTimeoutMs: 500,
      reconnectIntervalMs: 5_000,
      presencePulseMs: 1_000,
      fetch,
    });

    client.start();
    await client.ensureConnected();
    expect(actions).toEqual(["register"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(actions).toEqual(["register"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions).toEqual(["register", "pulse"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(actions).toEqual(["register", "pulse"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions).toEqual(["register", "pulse", "pulse"]);
    await client.close();
  });

  it("successful ordinary RPC postpones the pulse and carries its presence incarnation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    let pulseCalls = 0;
    let rpcPresence: { sessionId: string | null; presenceId: string | null } | undefined;
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      const action = parsePresenceAction(init);
      if (action === "pulse") {
        pulseCalls += 1;
      }
      const headers = new Headers(init?.headers);
      if (!action && headers.has(OAUTH_BROKER_SESSION_ID_HEADER)) {
        rpcPresence = {
          sessionId: headers.get(OAUTH_BROKER_SESSION_ID_HEADER),
          presenceId: headers.get(OAUTH_BROKER_PRESENCE_ID_HEADER),
        };
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 500,
      connectTimeoutMs: 500,
      reconnectIntervalMs: 5_000,
      presencePulseMs: 1_000,
      fetch,
    });

    client.start();
    await client.ensureConnected();
    await vi.advanceTimersByTimeAsync(750);
    await client.request("/v1/example");
    expect(rpcPresence).toEqual({
      sessionId: client.sessionId,
      presenceId: client.currentPresenceId,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(pulseCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pulseCalls).toBe(1);
    await client.close();
  });

  it("a newer successful RPC supersedes a concurrent pulse failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    const pulseGate = deferred();
    const pulseStarted = deferred();
    let pulseCalls = 0;
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      if (parsePresenceAction(init) === "pulse") {
        pulseCalls += 1;
        pulseStarted.resolve();
        await pulseGate.promise;
        throw new Error("simulated stale pulse failure");
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 500,
      connectTimeoutMs: 500,
      reconnectIntervalMs: 5_000,
      presencePulseMs: 1_000,
      fetch,
    });

    client.start();
    await client.ensureConnected();
    await vi.advanceTimersByTimeAsync(1_000);
    await pulseStarted.promise;
    await client.request("/v1/example");
    pulseGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.state).toBe("connected");
    await vi.advanceTimersByTimeAsync(999);
    expect(pulseCalls).toBe(1);
    await client.close();
  });

  it("heartbeat timeout publishes disconnected and reconnects on the next interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    let registerCalls = 0;
    let pulseCalls = 0;
    let releaseCalls = 0;
    const reconnectRegisterStarted = deferred();
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      const action = parsePresenceAction(init);
      if (action === "register") {
        registerCalls += 1;
        if (registerCalls === 2) {
          reconnectRegisterStarted.resolve();
        }
      } else if (action === "pulse") {
        pulseCalls += 1;
        return new Promise<Response>(() => undefined);
      } else if (action === "release") {
        releaseCalls += 1;
      }
      return successResponse(init, health);
    };
    const client = new OAuthBrokerClient({
      rootDir,
      namespaceId: access.namespaceId,
      configuredPort: access.port,
      requestTimeoutMs: 50,
      connectTimeoutMs: 500,
      reconnectIntervalMs: 20,
      presencePulseMs: 10,
      fetch,
    });

    client.start();
    await client.ensureConnected();
    await vi.advanceTimersByTimeAsync(10);
    expect(pulseCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("disconnected");
    expect(releaseCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(40);
    await reconnectRegisterStarted.promise;
    await client.ensureConnected();
    expect(registerCalls).toBe(2);
    expect(client.state).toBe("connected");
    await client.close();
  });

  it("close is idempotent and releases active presence once", async () => {
    const { rootDir, access, health } = createFixture();
    await writeOAuthBrokerAccess(rootDir, access);
    let releaseCalls = 0;
    const fetch = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      if (parsePresenceAction(init) === "release") {
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
    await client.ensureConnected();
    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;

    expect(client.state).toBe("closed");
    expect(releaseCalls).toBe(1);
  });

  it("close invalidates a late register and releases its presence incarnation", async () => {
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
    await client.close();
    expect(client.state).toBe("closed");
    registerGate.resolve();
    await waitFor(() => releaseCalls === 1, 1_000);

    expect(client.state).toBe("closed");
    expect(client.currentPresenceId).toBeUndefined();
    expect(() => client.ensureConnected()).toThrowError(
      expect.objectContaining({ code: "broker-client-closed" }),
    );
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
