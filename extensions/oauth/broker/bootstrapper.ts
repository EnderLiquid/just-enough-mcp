import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  OAuthBrokerClient,
  OAuthBrokerClientError,
  requestOAuthBrokerHealth,
} from "./client.ts";
import {
  createOAuthBrokerSecret,
  DEFAULT_OAUTH_BROKER_CLAIM_TTL_MS,
  DEFAULT_OAUTH_BROKER_ELECTION_WINDOW_MS,
  DEFAULT_OAUTH_BROKER_IDLE_GRACE_MS,
  DEFAULT_OAUTH_BROKER_PORT,
  DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
  DEFAULT_OAUTH_BROKER_PRESENCE_TTL_MS,
  DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
  DEFAULT_OAUTH_BROKER_STARTUP_TIMEOUT_MS,
  digestOAuthBrokerSecret,
  isProcessAlive,
  OAUTH_BROKER_CLAIM_FORMAT,
  OAUTH_BROKER_CLAIM_TOKEN_ENV,
  OAUTH_BROKER_PROTOCOL_VERSION,
  type OAuthBrokerOwnerClaim,
  type OAuthBrokerPublication,
} from "./protocol.ts";
import {
  createOAuthBrokerClaim,
  ensureOAuthBrokerRuntimeIdentity,
  listOAuthBrokerClaims,
  listOAuthBrokerPublications,
  OAuthBrokerRuntimeIdentityMismatchError,
  removeOAuthBrokerCandidate,
} from "./runtime-files.ts";

const DEFAULT_BROKER_ENTRYPOINT = fileURLToPath(new URL("./broker-process.ts", import.meta.url));
const POLL_INTERVAL_MS = 25;

export type OAuthBrokerBootstrapErrorCode =
  | "bootstrap-aborted"
  | "bootstrap-timeout"
  | "namespace-mismatch"
  | "multiple-brokers"
  | "existing-broker-unavailable"
  | "port-unavailable"
  | "claim-lost"
  | "broker-spawn-failed"
  | "broker-start-failed";

export class OAuthBrokerBootstrapError extends Error {
  readonly code: OAuthBrokerBootstrapErrorCode;

  constructor(code: OAuthBrokerBootstrapErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthBrokerBootstrapError";
    this.code = code;
  }
}

export interface OAuthBrokerBootstrapOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly requestedPort?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly electionWindowMs?: number;
  readonly claimTtlMs?: number;
  readonly presencePulseMs?: number;
  readonly presenceTtlMs?: number;
  readonly idleGraceMs?: number;
  readonly brokerEntrypoint?: string;
  readonly signal?: AbortSignal;
}

export interface OAuthBrokerBootstrapResult {
  readonly client: OAuthBrokerClient;
  readonly reused: boolean;
  readonly requestedPort: number;
  readonly actualPort: number;
}

export interface OAuthBrokerBootstrapper {
  start(): Promise<OAuthBrokerBootstrapResult>;
}

class DefaultOAuthBrokerBootstrapper implements OAuthBrokerBootstrapper {
  private readonly options: OAuthBrokerBootstrapOptions;
  private startPromise: Promise<OAuthBrokerBootstrapResult> | undefined;

  constructor(options: OAuthBrokerBootstrapOptions) {
    this.options = { ...options };
  }

  start(): Promise<OAuthBrokerBootstrapResult> {
    this.startPromise ??= bootstrapOAuthBroker(this.options);
    return this.startPromise;
  }
}

export function createOAuthBrokerBootstrapper(
  options: OAuthBrokerBootstrapOptions,
): OAuthBrokerBootstrapper {
  return new DefaultOAuthBrokerBootstrapper(options);
}

interface ResolvedBootstrapOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly requestedPort: number;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly electionWindowMs: number;
  readonly claimTtlMs: number;
  readonly presencePulseMs: number;
  readonly presenceTtlMs: number;
  readonly idleGraceMs: number;
  readonly brokerEntrypoint: string;
  readonly signal?: AbortSignal;
}

interface ChildState {
  readonly child: ChildProcess;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: Error;
}

/**
 * 发现或启动 agentDir-scoped broker，并为当前 session 注册 presence。
 *
 * owner election 使用永不复用的 UUID claim 路径。清理只作用于该 UUID，因此旧 owner
 * 无法删除后来 owner 的 descriptor。claim 只是启动期选举，不承担 access-token lease。
 */
export async function bootstrapOAuthBroker(
  input: OAuthBrokerBootstrapOptions,
): Promise<OAuthBrokerBootstrapResult> {
  const options = resolveOptions(input);
  const deadline = Date.now() + options.startupTimeoutMs;
  let ownClaim: { claim: OAuthBrokerOwnerClaim; token: string } | undefined;
  let childState: ChildState | undefined;
  let transferredClaim = false;

  try {
    await ensureOAuthBrokerRuntimeIdentity(options.rootDir, options.namespaceId);
  } catch (error) {
    if (error instanceof OAuthBrokerRuntimeIdentityMismatchError) {
      throw new OAuthBrokerBootstrapError("namespace-mismatch", error.message, { cause: error });
    }
    throw error;
  }

  try {
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const existing = await discoverExistingBroker(options);
      if (existing) {
        return await attachToBroker(existing, true, options);
      }

      await reapInactiveClaims(options);
      if (!ownClaim) {
        ownClaim = await createCandidateClaim(options, deadline);
        await sleep(options.electionWindowMs, options.signal);
      }

      const electedExisting = await discoverExistingBroker(options);
      if (electedExisting) {
        return await attachToBroker(electedExisting, true, options);
      }

      const activeClaims = await getActiveClaims(options);
      const winner = activeClaims[0];
      if (!winner || winner.claimId !== ownClaim.claim.claimId) {
        await sleep(POLL_INTERVAL_MS, options.signal);
        continue;
      }

      childState = spawnBroker(options, ownClaim);
      let publication: OAuthBrokerPublication;
      try {
        publication = await waitForBrokerPublication(options, ownClaim.claim.claimId, childState, deadline);
      } catch (error) {
        await stopUnpublishedChild(childState);
        childState = undefined;
        await removeOAuthBrokerCandidate(options.rootDir, ownClaim.claim.claimId).catch(() => undefined);
        ownClaim = undefined;
        if (error instanceof OAuthBrokerBootstrapError && error.code === "port-unavailable") {
          const racedBroker = await discoverExistingBroker(options);
          if (racedBroker) {
            return await attachToBroker(racedBroker, true, options);
          }
          throw error;
        }
        if (error instanceof OAuthBrokerBootstrapError && error.code === "claim-lost") {
          continue;
        }
        if (Date.now() >= deadline || error instanceof OAuthBrokerBootstrapError) {
          throw error;
        }
        continue;
      }

      transferredClaim = publication.endpoint.claimId === ownClaim.claim.claimId;
      return await attachToBroker(publication, !transferredClaim, options);
    }

    throw new OAuthBrokerBootstrapError(
      "bootstrap-timeout",
      `OAuth broker did not become ready within ${options.startupTimeoutMs} ms.`,
    );
  } finally {
    if (ownClaim && !transferredClaim) {
      await removeOAuthBrokerCandidate(options.rootDir, ownClaim.claim.claimId).catch(() => undefined);
    }
    if (childState && !transferredClaim) {
      await stopUnpublishedChild(childState);
    }
  }
}

async function attachToBroker(
  publication: OAuthBrokerPublication,
  reused: boolean,
  options: ResolvedBootstrapOptions,
): Promise<OAuthBrokerBootstrapResult> {
  const client = new OAuthBrokerClient({
    publication,
    requestTimeoutMs: options.requestTimeoutMs,
    presencePulseMs: options.presencePulseMs,
  });
  await client.start({ signal: options.signal, timeoutMs: options.requestTimeoutMs });
  return {
    client,
    reused,
    requestedPort: options.requestedPort,
    actualPort: publication.endpoint.port,
  };
}

async function discoverExistingBroker(
  options: ResolvedBootstrapOptions,
): Promise<OAuthBrokerPublication | undefined> {
  const publications = await listOAuthBrokerPublications(options.rootDir);
  const healthy: OAuthBrokerPublication[] = [];

  for (const publication of publications) {
    const endpoint = publication.endpoint;
    if (endpoint.namespaceId !== options.namespaceId) {
      if (isProcessAlive(endpoint.pid)) {
        throw new OAuthBrokerBootstrapError(
          "namespace-mismatch",
          "A live OAuth broker in this runtime directory belongs to a different agentDir namespace.",
        );
      }
      await removeOAuthBrokerCandidate(options.rootDir, endpoint.claimId).catch(() => undefined);
      continue;
    }

    if (!isProcessAlive(endpoint.pid)) {
      await removeOAuthBrokerCandidate(options.rootDir, endpoint.claimId).catch(() => undefined);
      continue;
    }

    try {
      await requestOAuthBrokerHealth(publication, { timeoutMs: options.requestTimeoutMs });
      healthy.push(publication);
    } catch (error) {
      if (error instanceof OAuthBrokerClientError
        && (error.code === "broker-timeout" || error.code === "broker-unavailable")) {
        throw new OAuthBrokerBootstrapError(
          "existing-broker-unavailable",
          "An OAuth broker process is alive but its control plane is unavailable.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (healthy.length > 1) {
    throw new OAuthBrokerBootstrapError(
      "multiple-brokers",
      "Multiple live OAuth brokers were discovered for one agentDir namespace.",
    );
  }
  return healthy[0];
}

async function createCandidateClaim(
  options: ResolvedBootstrapOptions,
  deadline: number,
): Promise<{ claim: OAuthBrokerOwnerClaim; token: string }> {
  const now = Date.now();
  const token = createOAuthBrokerSecret();
  const claim: OAuthBrokerOwnerClaim = {
    format: OAUTH_BROKER_CLAIM_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId: options.namespaceId,
    claimId: randomUUID(),
    claimTokenDigest: digestOAuthBrokerSecret(token),
    claimantPid: process.pid,
    requestedPort: options.requestedPort,
    createdAt: now,
    expiresAt: Math.max(deadline + options.electionWindowMs, now + options.claimTtlMs),
  };
  await createOAuthBrokerClaim(options.rootDir, claim);
  return { claim, token };
}

async function getActiveClaims(
  options: ResolvedBootstrapOptions,
): Promise<OAuthBrokerOwnerClaim[]> {
  const now = Date.now();
  const claims = await listOAuthBrokerClaims(options.rootDir);
  const active: OAuthBrokerOwnerClaim[] = [];

  for (const claim of claims) {
    if (claim.namespaceId !== options.namespaceId) {
      if (claim.expiresAt > now && isProcessAlive(claim.claimantPid)) {
        throw new OAuthBrokerBootstrapError(
          "namespace-mismatch",
          "An active OAuth broker claim belongs to a different agentDir namespace.",
        );
      }
      await removeOAuthBrokerCandidate(options.rootDir, claim.claimId).catch(() => undefined);
      continue;
    }

    if (claim.expiresAt <= now || !isProcessAlive(claim.claimantPid)) {
      await removeOAuthBrokerCandidate(options.rootDir, claim.claimId).catch(() => undefined);
      continue;
    }
    active.push(claim);
  }

  return active.sort((left, right) =>
    left.createdAt - right.createdAt || left.claimId.localeCompare(right.claimId));
}

async function reapInactiveClaims(options: ResolvedBootstrapOptions): Promise<void> {
  await getActiveClaims(options);
}

function spawnBroker(
  options: ResolvedBootstrapOptions,
  owner: { claim: OAuthBrokerOwnerClaim; token: string },
): ChildState {
  const child = spawn(process.execPath, [
    options.brokerEntrypoint,
    "--root", options.rootDir,
    "--namespace", options.namespaceId,
    "--claim", owner.claim.claimId,
    "--port", String(options.requestedPort),
    "--presence-ttl-ms", String(options.presenceTtlMs),
    "--idle-grace-ms", String(options.idleGraceMs),
  ], {
    detached: true,
    env: {
      ...process.env,
      [OAUTH_BROKER_CLAIM_TOKEN_ENV]: owner.token,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const state: ChildState = { child };
  child.once("error", error => {
    state.error = error;
  });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  child.unref();
  return state;
}

async function waitForBrokerPublication(
  options: ResolvedBootstrapOptions,
  claimId: string,
  childState: ChildState,
  deadline: number,
): Promise<OAuthBrokerPublication> {
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    if (childState.error) {
      throw new OAuthBrokerBootstrapError(
        "broker-spawn-failed",
        "OAuth broker process could not be spawned.",
        { cause: childState.error },
      );
    }

    const publication = await discoverExistingBroker(options);
    if (publication) {
      return publication;
    }

    if (childState.exit) {
      if (childState.exit.code === 17) {
        throw new OAuthBrokerBootstrapError(
          "port-unavailable",
          `OAuth broker could not bind configured port ${options.requestedPort}.`,
        );
      }
      if (childState.exit.code === 20) {
        throw new OAuthBrokerBootstrapError(
          "claim-lost",
          "OAuth broker owner claim lost the startup election.",
        );
      }
      throw new OAuthBrokerBootstrapError(
        "broker-start-failed",
        `OAuth broker process exited before publishing its endpoint (code ${childState.exit.code ?? childState.exit.signal ?? "unknown"}).`,
      );
    }
    await sleep(POLL_INTERVAL_MS, options.signal);
  }

  throw new OAuthBrokerBootstrapError(
    "bootstrap-timeout",
    `OAuth broker did not publish a healthy endpoint for claim ${claimId} before the startup timeout.`,
  );
}

async function stopUnpublishedChild(state: ChildState): Promise<void> {
  const pid = state.child.pid;
  if (pid && isProcessAlive(pid)) {
    state.child.kill("SIGTERM");
    await waitFor(() => !isProcessAlive(pid), 1_000).catch(() => undefined);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for OAuth broker process cleanup.");
}

function resolveOptions(input: OAuthBrokerBootstrapOptions): ResolvedBootstrapOptions {
  if (typeof input.rootDir !== "string" || input.rootDir.length === 0) {
    throw new TypeError("OAuth broker rootDir must be a non-empty string.");
  }
  if (typeof input.namespaceId !== "string" || input.namespaceId.trim().length === 0) {
    throw new TypeError("OAuth broker namespaceId must be a non-empty string.");
  }

  const requestedPort = requireIntegerInRange(
    input.requestedPort ?? DEFAULT_OAUTH_BROKER_PORT,
    1,
    65_535,
    "requestedPort",
  );
  const startupTimeoutMs = requirePositiveFinite(
    input.startupTimeoutMs ?? DEFAULT_OAUTH_BROKER_STARTUP_TIMEOUT_MS,
    "startupTimeoutMs",
  );
  const requestTimeoutMs = requirePositiveFinite(
    input.requestTimeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const electionWindowMs = requirePositiveFinite(
    input.electionWindowMs ?? DEFAULT_OAUTH_BROKER_ELECTION_WINDOW_MS,
    "electionWindowMs",
  );
  const claimTtlMs = requirePositiveFinite(
    input.claimTtlMs ?? DEFAULT_OAUTH_BROKER_CLAIM_TTL_MS,
    "claimTtlMs",
  );
  const presencePulseMs = requirePositiveFinite(
    input.presencePulseMs ?? DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
    "presencePulseMs",
  );
  const presenceTtlMs = requirePositiveFinite(
    input.presenceTtlMs ?? DEFAULT_OAUTH_BROKER_PRESENCE_TTL_MS,
    "presenceTtlMs",
  );
  const idleGraceMs = requirePositiveFinite(
    input.idleGraceMs ?? DEFAULT_OAUTH_BROKER_IDLE_GRACE_MS,
    "idleGraceMs",
  );
  if (presencePulseMs >= presenceTtlMs) {
    throw new TypeError("presencePulseMs must be smaller than presenceTtlMs.");
  }

  return {
    rootDir: input.rootDir,
    namespaceId: input.namespaceId.trim(),
    requestedPort,
    startupTimeoutMs,
    requestTimeoutMs,
    electionWindowMs,
    claimTtlMs,
    presencePulseMs,
    presenceTtlMs,
    idleGraceMs,
    brokerEntrypoint: input.brokerEntrypoint ?? DEFAULT_BROKER_ENTRYPOINT,
    signal: input.signal,
  };
}

function requirePositiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive finite number.`);
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${fieldName} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OAuthBrokerBootstrapError(
      "bootstrap-aborted",
      "OAuth broker bootstrap was aborted.",
      { cause: signal.reason },
    );
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new OAuthBrokerBootstrapError("bootstrap-aborted", "OAuth broker bootstrap was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OAuthBrokerBootstrapError(
        "bootstrap-aborted",
        "OAuth broker bootstrap was aborted.",
        { cause: signal?.reason },
      ));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
