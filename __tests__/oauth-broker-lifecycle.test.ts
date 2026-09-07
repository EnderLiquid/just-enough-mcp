import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapOAuthBroker,
  type OAuthBrokerBootstrapOptions,
  type OAuthBrokerBootstrapResult,
} from "../extensions/oauth/broker/bootstrapper.js";
import { requestOAuthBrokerHealth } from "../extensions/oauth/broker/client.js";
import {
  createOAuthBrokerRequestEnvelope,
  getOAuthBrokerUrl,
  isProcessAlive,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  type OAuthBrokerEndpointDescriptor,
  type OAuthBrokerPublication,
} from "../extensions/oauth/broker/protocol.js";
import {
  getOAuthBrokerPublicationPaths,
  listOAuthBrokerClaims,
  listOAuthBrokerPublications,
  readOAuthBrokerPublication,
  removeOAuthBrokerCandidate,
} from "../extensions/oauth/broker/runtime-files.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const WORKER_PATH = fileURLToPath(
  new URL("./fixtures/oauth-broker-bootstrap-worker.ts", import.meta.url),
);
const tempDirs = createTempDirFixture("just-enough-mcp-oauth-broker");
const roots = new Set<string>();
const trackedPids = new Set<number>();

interface WorkerResult {
  readonly ok: true;
  readonly reused: boolean;
  readonly requestedPort: number;
  readonly actualPort: number;
  readonly endpoint: OAuthBrokerEndpointDescriptor;
}

afterEach(async () => {
  for (const root of roots) {
    for (const publication of await listOAuthBrokerPublications(root).catch(() => [])) {
      trackedPids.add(publication.endpoint.pid);
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
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 500,
    electionWindowMs: 75,
    claimTtlMs: 7_000,
    presencePulseMs: 50,
    presenceTtlMs: 500,
    idleGraceMs: 150,
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

async function runWorker(options: OAuthBrokerBootstrapOptions, holdMs = 400): Promise<WorkerResult> {
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
  trackedPids.add(payload.endpoint.pid);
  return payload;
}

function isWorkerResult(value: unknown): value is WorkerResult {
  return typeof value === "object" && value !== null
    && "ok" in value && value.ok === true
    && "endpoint" in value && typeof value.endpoint === "object" && value.endpoint !== null
    && "pid" in value.endpoint && typeof value.endpoint.pid === "number";
}

async function terminateProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
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

async function closeAndWait(result: OAuthBrokerBootstrapResult): Promise<void> {
  const pid = result.client.endpoint.pid;
  trackedPids.add(pid);
  await result.client.close();
  await waitFor(() => !isProcessAlive(pid), 3_000);
  trackedPids.delete(pid);
}

describe("standalone OAuth broker lifecycle", () => {
  it("多个独立 bootstrap 进程即使请求不同端口也只选出一个 broker owner", async () => {
    const rootDir = createRoot();
    const [firstPort, secondPort] = await allocateDistinctPorts();
    const namespaceId = "agent-dir:v1:" + "a".repeat(64);

    const workers = await Promise.all(
      Array.from({ length: 6 }, (_, index) => runWorker(
        makeOptions(rootDir, namespaceId, index % 2 === 0 ? firstPort : secondPort),
      )),
    );

    expect(new Set(workers.map(worker => worker.endpoint.instanceId))).toHaveLength(1);
    expect(new Set(workers.map(worker => worker.endpoint.pid))).toHaveLength(1);
    expect(new Set(workers.map(worker => worker.actualPort))).toHaveLength(1);
    expect([firstPort, secondPort]).toContain(workers[0]!.actualPort);
    expect(workers.filter(worker => !worker.reused)).toHaveLength(1);

    const pid = workers[0]!.endpoint.pid;
    await waitFor(() => !isProcessAlive(pid), 3_000);
    trackedPids.delete(pid);
    expect(await listOAuthBrokerClaims(rootDir)).toEqual([]);
    expect(await listOAuthBrokerPublications(rootDir)).toEqual([]);
  }, 15_000);

  it("优先复用旧 endpoint，并保留旧 broker 的实际端口", async () => {
    const rootDir = createRoot();
    const [firstPort, changedPort] = await allocateDistinctPorts();
    const namespaceId = "agent-dir:v1:" + "b".repeat(64);
    const first = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, firstPort));
    trackedPids.add(first.client.endpoint.pid);
    const second = await bootstrapOAuthBroker(makeOptions(rootDir, namespaceId, changedPort));

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.actualPort).toBe(firstPort);
    expect(second.requestedPort).toBe(changedPort);
    expect(second.client.endpoint.instanceId).toBe(first.client.endpoint.instanceId);

    await first.client.close();
    expect((await second.client.health()).presenceCount).toBe(1);
    await closeAndWait(second);
  });

  it("endpoint 不包含 secret，控制面拒绝未认证请求，callback 使用同一 listener", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const result = await bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "c".repeat(64),
      port,
      { idleGraceMs: 500 },
    ));
    trackedPids.add(result.client.endpoint.pid);

    const paths = getOAuthBrokerPublicationPaths(rootDir, result.client.endpoint.claimId);
    const endpointText = await readFile(paths.endpointPath, "utf8");
    const accessText = await readFile(paths.accessPath, "utf8");
    const publication = await readOAuthBrokerPublication(rootDir, result.client.endpoint.claimId);
    expect(publication).toBeDefined();
    expect(endpointText).not.toContain("secret");
    expect(endpointText).not.toContain("ownerToken");
    expect(endpointText).not.toContain(publication!.access.secret);
    expect(accessText).toContain(publication!.access.secret);

    const requestId = randomUUID();
    const unauthorized = await fetch(getOAuthBrokerUrl(result.client.endpoint, OAUTH_BROKER_ROUTES.health), {
      headers: { [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code: "unauthorized" },
    });

    const callback = await fetch(
      `${getOAuthBrokerUrl(result.client.endpoint, OAUTH_BROKER_ROUTES.callback)}?code=secret-code&state=secret-state`,
    );
    expect(callback.status).toBe(400);
    expect(await callback.text()).toBe("OAuth authorization transaction was not found.");

    await closeAndWait(result);
  });

  it("同一 runtime directory 拒绝复用其他 namespace 的 live broker", async () => {
    const rootDir = createRoot();
    const [firstPort, secondPort] = await allocateDistinctPorts();
    const first = await bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "9".repeat(64),
      firstPort,
      { idleGraceMs: 500 },
    ));
    trackedPids.add(first.client.endpoint.pid);

    await expect(bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "8".repeat(64),
      secondPort,
    ))).rejects.toMatchObject({ code: "namespace-mismatch" });
    expect((await first.client.health()).instanceId).toBe(first.client.endpoint.instanceId);

    await closeAndWait(first);
  });

  it("固定端口被占用时明确失败且不选择 fallback 端口", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const occupant = createServer((_request, response) => {
      response.writeHead(200);
      response.end("occupied");
    });
    await listen(occupant, port);

    try {
      await expect(bootstrapOAuthBroker(makeOptions(
        rootDir,
        "agent-dir:v1:" + "d".repeat(64),
        port,
      ))).rejects.toMatchObject({ code: "port-unavailable" });
      expect(await fetch(`http://127.0.0.1:${port}`).then(response => response.text())).toBe("occupied");
      expect(await listOAuthBrokerPublications(rootDir)).toEqual([]);
      expect(await listOAuthBrokerClaims(rootDir)).toEqual([]);
    } finally {
      await closeServer(occupant);
    }
  });

  it("broker hard crash 后清理旧 publication 并启动新 instance", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const options = makeOptions(
      rootDir,
      "agent-dir:v1:" + "e".repeat(64),
      port,
      { idleGraceMs: 1_000 },
    );
    const first = await bootstrapOAuthBroker(options);
    const firstPid = first.client.endpoint.pid;
    const firstInstanceId = first.client.endpoint.instanceId;
    trackedPids.add(firstPid);

    await terminateProcess(firstPid);
    await first.client.close();
    const second = await bootstrapOAuthBroker(options);
    trackedPids.add(second.client.endpoint.pid);

    expect(second.reused).toBe(false);
    expect(second.client.endpoint.instanceId).not.toBe(firstInstanceId);
    expect(second.client.endpoint.pid).not.toBe(firstPid);
    expect((await second.client.health()).presenceCount).toBe(1);

    await removeOAuthBrokerCandidate(rootDir, first.client.endpoint.claimId);
    expect((await second.client.health()).instanceId).toBe(second.client.endpoint.instanceId);

    await closeAndWait(second);
  });

  it("release 后的迟到 pulse 不会重新注册 presence", async () => {
    const rootDir = createRoot();
    const port = await allocatePort();
    const result = await bootstrapOAuthBroker(makeOptions(
      rootDir,
      "agent-dir:v1:" + "f".repeat(64),
      port,
      { idleGraceMs: 1_000 },
    ));
    trackedPids.add(result.client.endpoint.pid);
    const publication = await readOAuthBrokerPublication(rootDir, result.client.endpoint.claimId);
    expect(publication).toBeDefined();

    await result.client.close();
    const pulse = await rawPresence(publication!, "pulse", result.client.sessionId);
    expect(pulse.status).toBe(409);
    expect(pulse.payload).toMatchObject({ ok: false, error: { code: "presence-not-found" } });
    expect((await requestOAuthBrokerHealth(publication!, { timeoutMs: 500 })).presenceCount).toBe(0);

    await waitFor(() => !isProcessAlive(result.client.endpoint.pid), 3_000);
    trackedPids.delete(result.client.endpoint.pid);
  });
});

async function rawPresence(
  publication: OAuthBrokerPublication,
  action: "register" | "pulse" | "release",
  sessionId: string,
): Promise<{ status: number; payload: unknown }> {
  const requestId = randomUUID();
  const response = await fetch(getOAuthBrokerUrl(publication.endpoint, OAUTH_BROKER_ROUTES.presence), {
    method: "POST",
    headers: {
      authorization: `Bearer ${publication.access.secret}`,
      "content-type": "application/json",
      [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId,
    },
    body: JSON.stringify(createOAuthBrokerRequestEnvelope(requestId, { action, sessionId })),
  });
  return {
    status: response.status,
    payload: await response.json() as unknown,
  };
}
