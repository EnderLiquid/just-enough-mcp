import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapOAuthBroker,
  diagnoseOAuthBroker,
  type OAuthBrokerBootstrapOptions,
} from "../extensions/oauth/broker/bootstrapper.js";
import {
  createOAuthBrokerRequestEnvelope,
  getOAuthBrokerUrl,
  isProcessAlive,
  OAUTH_BROKER_PRESENCE_ID_HEADER,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  OAUTH_BROKER_SESSION_ID_HEADER,
} from "../extensions/oauth/broker/protocol.js";
import { readOAuthBrokerAccess } from "../extensions/oauth/broker/runtime-files.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const WORKER_PATH = fileURLToPath(
  new URL("./fixtures/oauth-broker-bootstrap-worker.ts", import.meta.url),
);
const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker");
const roots = new Set<string>();
const trackedPids = new Set<number>();

interface WorkerResult {
  readonly ok: true;
  readonly spawned: boolean;
  readonly reused: boolean;
  readonly requestedPort: number;
  readonly actualPort: number;
  readonly state: string;
  readonly presenceId: string;
  readonly health: {
    readonly instanceId: string;
    readonly pid: number;
    readonly port: number;
    readonly presenceCount: number;
  };
}

afterEach(async () => {
  for (const root of roots) {
    const access = await readOAuthBrokerAccess(root).catch(() => undefined);
    if (access) {
      trackedPids.add((await probeHealth(access.port, access.secret)).pid ?? 0);
    }
  }
  for (const pid of trackedPids) {
    await terminateProcess(pid);
  }
  trackedPids.clear();
  roots.clear();
  tempDirs.cleanup();
});

function createRoot(): string {
  const root = tempDirs.create();
  roots.add(root);
  return root;
}

function makeOptions(
  rootDir: string,
  namespaceId: string,
  requestedPort: number,
  overrides: Partial<OAuthBrokerBootstrapOptions> = {},
): OAuthBrokerBootstrapOptions {
  return {
    rootDir,
    namespaceId,
    requestedPort,
    requestTimeoutMs: 500,
    diagnosticTimeoutMs: 100,
    reconnectIntervalMs: 50,
    presencePulseMs: 50,
    presenceTtlMs: 500,
    idleGraceMs: 150,
    lockStaleMs: 2_000,
    lockUpdateMs: 1_000,
    ...overrides,
  };
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await closeServer(server);
  if (!port) {
    throw new Error("Expected the OS to allocate a loopback port.");
  }
  return port;
}

async function allocateDistinctPorts(): Promise<[number, number]> {
  const first = createServer();
  const second = createServer();
  await listen(first, 0);
  await listen(second, 0);
  const firstAddress = first.address();
  const secondAddress = second.address();
  const firstPort = typeof firstAddress === "object" && firstAddress ? firstAddress.port : undefined;
  const secondPort = typeof secondAddress === "object" && secondAddress ? secondAddress.port : undefined;
  await Promise.all([closeServer(first), closeServer(second)]);
  if (!firstPort || !secondPort || firstPort === secondPort) {
    throw new Error("Expected two distinct loopback ports.");
  }
  return [firstPort, secondPort];
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function runWorker(
  options: OAuthBrokerBootstrapOptions,
  holdMs = 300,
): Promise<WorkerResult> {
  const child = spawn(process.execPath, [WORKER_PATH], {
    env: {
      ...process.env,
      OAUTH_BROKER_TEST_OPTIONS: JSON.stringify({ ...options, holdMs }),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("OAuth broker bootstrap worker timed out."));
      }, 10_000);
      child.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );

  const output = exit.code === 0 ? stdout.trim().split(/\r?\n/).at(-1) : stderr.trim().split(/\r?\n/).at(-1);
  let payload: unknown;
  try {
    payload = output ? JSON.parse(output) as unknown : undefined;
  } catch {
    payload = undefined;
  }
  if (exit.code !== 0 || !isWorkerResult(payload)) {
    throw new Error(
      `OAuth broker bootstrap worker failed (${exit.code ?? exit.signal ?? "unknown"}): ${stderr || stdout}`,
    );
  }
  trackedPids.add(payload.health.pid);
  return payload;
}

function isWorkerResult(value: unknown): value is WorkerResult {
  return typeof value === "object" && value !== null
    && "ok" in value && value.ok === true
    && "presenceId" in value && typeof value.presenceId === "string"
    && "health" in value && typeof value.health === "object" && value.health !== null
    && "pid" in value.health && typeof value.health.pid === "number";
}

async function terminateProcess(pid: number): Promise<void> {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitFor(() => !isProcessAlive(pid), 2_000).catch(() => undefined);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

async function probeHealth(port: number, secret: string): Promise<{ pid?: number }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${OAUTH_BROKER_ROUTES.health}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    const payload = await response.json() as { result?: { pid?: number } };
    return { pid: payload.result?.pid };
  } catch {
    return {};
  }
}

describe("simplified standalone OAuth broker lifecycle", () => {
  it("多个独立 session 同时启动时由 lock + fixed bind 收敛到一个 owner", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const namespaceId = "agent-dir:v1:" + "a".repeat(64);

    const workers = await Promise.all(
      Array.from({ length: 6 }, () => runWorker(makeOptions(rootDir, namespaceId, port))),
    );

    expect(new Set(workers.map(worker => worker.health.instanceId))).toHaveLength(1);
    expect(new Set(workers.map(worker => worker.health.pid))).toHaveLength(1);
    expect(new Set(workers.map(worker => worker.actualPort))).toEqual(new Set([port]));
    expect(workers.every(worker => worker.state === "connected")).toBe(true);
    expect(workers.some(worker => worker.spawned)).toBe(true);
  }, 15_000);

  it("配置端口改变时不发现或复用旧端口", async () => {
    const rootDir = createRoot();
    const [firstPort, changedPort] = await allocateDistinctPorts();
    const namespaceId = "agent-dir:v1:" + "b".repeat(64);
    const first = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, firstPort));
    await first.client.ensureConnected({ timeoutMs: 2_000 });
    trackedPids.add((await first.client.health()).pid);

    const warning: string[] = [];
    const second = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, changedPort, {
      onWarning: message => warning.push(message),
    }));
    expect(second.reused).toBe(false);
    expect(second.actualPort).toBe(changedPort);
    expect(second.diagnostic.lockHeld).toBe(true);
    expect(second.diagnostic.portOccupied).toBe(false);
    expect(second.client.state).not.toBe("connected");
    expect(warning.join(" ")).toMatch(/lock|port|reload/i);

    await second.client.close();
    await first.client.close();
  });

  it("未知的固定端口占用只产生 warning，不静默切换端口", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const occupant = createServer((_request, response) => {
      response.writeHead(200);
      response.end("occupied");
    });
    await listen(occupant, port);
    try {
      const warning: string[] = [];
      const result = await bootstrapOAuthBroker(makeOptions(
        rootDir,
        "agent-dir:v1:" + "c".repeat(64),
        port,
        { onWarning: message => warning.push(message) },
      ));
      expect(result.spawned).toBe(false);
      expect(result.diagnostic.lockHeld).toBe(false);
      expect(result.diagnostic.portOccupied).toBe(true);
      expect(result.client.state).not.toBe("connected");
      expect(warning.join(" ")).toMatch(/occupied|fallback|port/i);
      await result.client.close();
    } finally {
      await closeServer(occupant);
    }
  });

  it("broker 退出后 access file 可保留，下一 instance 原子覆盖它", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const namespaceId = "agent-dir:v1:" + "d".repeat(64);
    const first = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, port, { idleGraceMs: 100 }));
    await first.client.ensureConnected({ timeoutMs: 2_000 });
    const firstAccess = await readOAuthBrokerAccess(rootDir);
    expect(firstAccess).toBeDefined();
    trackedPids.add((await first.client.health()).pid);
    await first.client.close();
    await waitFor(async () => !(await probeHealth(port, firstAccess!.secret)).pid, 3_000);

    const staleAccess = await readOAuthBrokerAccess(rootDir);
    expect(staleAccess?.instanceId).toBe(firstAccess?.instanceId);

    const second = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, port));
    await second.client.ensureConnected({ timeoutMs: 2_000 });
    const secondAccess = await readOAuthBrokerAccess(rootDir);
    expect(secondAccess?.instanceId).not.toBe(firstAccess?.instanceId);
    expect(second.client.state).toBe("connected");
    trackedPids.add((await second.client.health()).pid);
    await second.client.close();
  });

  it("broker hard crash 后 stale lock 到期，新 session 才能重新取得固定端口", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const namespaceId = "agent-dir:v1:" + "f".repeat(64);
    const options = makeOptions(rootDir, namespaceId, port, {
      idleGraceMs: 500,
      lockStaleMs: 2_000,
      lockUpdateMs: 1_000,
    });
    const first = await bootstrapOAuthBroker(options);
    await first.client.ensureConnected({ timeoutMs: 2_000 });
    const firstHealth = await first.client.health();
    trackedPids.add(firstHealth.pid);

    await terminateProcess(firstHealth.pid);
    await first.client.close();
    await waitFor(
      async () => (await diagnoseOAuthBroker(options)).lockHeld === false,
      5_000,
    );

    const second = await bootstrapOAuthBroker(options);
    await second.client.ensureConnected();
    const secondHealth = await second.client.health();
    trackedPids.add(secondHealth.pid);
    expect(second.spawned).toBe(true);
    expect(secondHealth.instanceId).not.toBe(firstHealth.instanceId);
    await second.client.close();
  }, 10_000);

  it("带当前 incarnation 的认证 RPC 会续期 broker presence", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const result = await bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "1".repeat(64),
      port,
      { presenceTtlMs: 600, idleGraceMs: 1_000 },
    ));
    await result.client.ensureConnected({ timeoutMs: 2_000 });
    const access = (await readOAuthBrokerAccess(rootDir))!;
    trackedPids.add((await result.client.health()).pid);

    const sessionId = randomUUID();
    const presenceId = randomUUID();
    expect((await rawPresence(access, "register", sessionId, presenceId)).status).toBe(200);
    await result.client.close();

    await new Promise(resolve => setTimeout(resolve, 350));
    expect((await rawHealth(access, { sessionId, presenceId })).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 400));

    const observed = await rawHealth(access);
    expect(observed.status).toBe(200);
    expect(observed.payload).toMatchObject({
      ok: true,
      result: { presenceCount: 1 },
    });
    await rawPresence(access, "release", sessionId, presenceId);
  });

  it("broker hard crash 后 heartbeat 使 session client 进入 disconnected", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const options = makeOptions(rootDir, "agent-dir:v1:" + "g".repeat(64), port, {
      requestTimeoutMs: 100,
      reconnectIntervalMs: 50,
      presencePulseMs: 50,
      presenceTtlMs: 250,
      idleGraceMs: 500,
    });
    const result = await bootstrapOAuthBroker(options);
    await result.client.ensureConnected({ timeoutMs: 2_000 });
    const health = await result.client.health({ timeoutMs: 1_000 });
    trackedPids.add(health.pid);

    await terminateProcess(health.pid);
    await waitFor(() => result.client.state === "disconnected", 3_000);

    expect(result.client.currentPresenceId).toBeUndefined();
    await result.client.close();
  });

  it("旧 presence release 不能影响新 incarnation", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const result = await bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "e".repeat(64),
      port,
      { idleGraceMs: 500 },
    ));
    await result.client.ensureConnected({ timeoutMs: 2_000 });
    const firstPresenceId = result.client.currentPresenceId!;
    const access = await readOAuthBrokerAccess(rootDir);
    const firstHealth = await result.client.health();
    trackedPids.add(firstHealth.pid);

    await result.client.disconnect();
    await result.client.ensureConnected({ timeoutMs: 2_000 });
    const secondPresenceId = result.client.currentPresenceId!;
    expect(secondPresenceId).not.toBe(firstPresenceId);

    const staleRelease = await rawPresence(access!, "release", result.client.sessionId, firstPresenceId);
    expect(staleRelease.status).toBe(409);
    expect((await result.client.health()).presenceCount).toBe(1);
    await result.client.close();
  });
});

async function rawHealth(
  access: NonNullable<Awaited<ReturnType<typeof readOAuthBrokerAccess>>>,
  presence?: { sessionId: string; presenceId: string },
): Promise<{ status: number; payload: unknown }> {
  const requestId = randomUUID();
  const response = await fetch(getOAuthBrokerUrl(access.port, OAUTH_BROKER_ROUTES.health), {
    headers: {
      authorization: `Bearer ${access.secret}`,
      [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId,
      ...(presence === undefined ? {} : {
        [OAUTH_BROKER_SESSION_ID_HEADER]: presence.sessionId,
        [OAUTH_BROKER_PRESENCE_ID_HEADER]: presence.presenceId,
      }),
    },
  });
  return { status: response.status, payload: await response.json() as unknown };
}

async function rawPresence(
  access: NonNullable<Awaited<ReturnType<typeof readOAuthBrokerAccess>>>,
  action: "register" | "pulse" | "release",
  sessionId: string,
  presenceId: string,
): Promise<{ status: number; payload: unknown }> {
  const requestId = randomUUID();
  const response = await fetch(getOAuthBrokerUrl(access.port, OAUTH_BROKER_ROUTES.presence), {
    method: "POST",
    headers: {
      authorization: `Bearer ${access.secret}`,
      "content-type": "application/json",
      [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId,
    },
    body: JSON.stringify(createOAuthBrokerRequestEnvelope(requestId, {
      action,
      sessionId,
      presenceId,
    })),
  });
  return { status: response.status, payload: await response.json() as unknown };
}
