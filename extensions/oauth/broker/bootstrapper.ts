import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  OAuthBrokerClient,
  readAndRequestOAuthBrokerHealth,
} from "./client.ts";
import {
  DEFAULT_OAUTH_BROKER_IDLE_GRACE_MS,
  DEFAULT_OAUTH_BROKER_LOCK_STALE_MS,
  DEFAULT_OAUTH_BROKER_LOCK_UPDATE_MS,
  DEFAULT_OAUTH_BROKER_PORT,
  DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
  DEFAULT_OAUTH_BROKER_PRESENCE_TTL_MS,
  DEFAULT_OAUTH_BROKER_RECONNECT_INTERVAL_MS,
  DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
  assertOAuthBrokerPort,
} from "./protocol.ts";
import {
  ensureOAuthBrokerRuntimeDirectories,
} from "./runtime-files.ts";
import { isOAuthBrokerLockHeld, OAuthBrokerLockError } from "./lock.ts";

const DEFAULT_BROKER_ENTRYPOINT = fileURLToPath(new URL("./broker-process.ts", import.meta.url));

export type OAuthBrokerBootstrapErrorCode =
  | "bootstrap-aborted"
  | "invalid-options"
  | "diagnostic-failed"
  | "broker-spawn-failed";

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
  readonly requestTimeoutMs?: number;
  readonly diagnosticTimeoutMs?: number;
  readonly reconnectIntervalMs?: number;
  readonly presencePulseMs?: number;
  readonly presenceTtlMs?: number;
  readonly idleGraceMs?: number;
  readonly lockStaleMs?: number;
  readonly lockUpdateMs?: number;
  readonly brokerEntrypoint?: string;
  /** Allows the composition root to own the session client while this launcher remains non-owning. */
  readonly client?: OAuthBrokerClient;
  readonly signal?: AbortSignal;
  readonly onWarning?: (message: string, error?: unknown) => void;
}

export interface OAuthBrokerBootstrapResult {
  readonly client: OAuthBrokerClient;
  readonly spawned: boolean;
  readonly reused: boolean;
  readonly requestedPort: number;
  readonly actualPort: number;
  readonly diagnostic: OAuthBrokerLaunchDiagnostic;
}

export interface OAuthBrokerLaunchDiagnostic {
  readonly lockHeld: boolean | "unknown";
  readonly portOccupied: boolean | "unknown";
  readonly compatibleHealth: boolean;
}

export interface OAuthBrokerBootstrapper {
  start(): Promise<OAuthBrokerBootstrapResult>;
}

interface ResolvedBootstrapOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly requestedPort: number;
  readonly requestTimeoutMs: number;
  readonly diagnosticTimeoutMs: number;
  readonly reconnectIntervalMs: number;
  readonly presencePulseMs: number;
  readonly presenceTtlMs: number;
  readonly idleGraceMs: number;
  readonly lockStaleMs: number;
  readonly lockUpdateMs: number;
  readonly brokerEntrypoint: string;
  readonly client?: OAuthBrokerClient;
  readonly signal?: AbortSignal;
  readonly onWarning?: (message: string, error?: unknown) => void;
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

/**
 * Performs only best-effort launch diagnostics and starts the client. It never
 * waits for the child process to bind or for presence registration to succeed.
 */
export async function bootstrapOAuthBroker(
  input: OAuthBrokerBootstrapOptions,
): Promise<OAuthBrokerBootstrapResult> {
  const options = resolveOptions(input);
  throwIfAborted(options.signal);
  await ensureOAuthBrokerRuntimeDirectories(options.rootDir);

  const diagnostic = await diagnose(options);
  throwIfAborted(options.signal);

  let spawned = false;
  let reused = diagnostic.compatibleHealth;
  if (diagnostic.lockHeld === false && diagnostic.portOccupied === false) {
    try {
      spawnBroker(options);
      spawned = true;
    } catch (error) {
      options.onWarning?.("OAuth broker could not be launched; OAuth remains unavailable until reload.", error);
    }
  } else if (!diagnostic.compatibleHealth) {
    options.onWarning?.(diagnosticWarning(diagnostic));
  }

  const client = options.client ?? new OAuthBrokerClient({
    rootDir: options.rootDir,
    namespaceId: options.namespaceId,
    configuredPort: options.requestedPort,
    requestTimeoutMs: options.requestTimeoutMs,
    reconnectIntervalMs: options.reconnectIntervalMs,
    presencePulseMs: options.presencePulseMs,
  });
  client.start();

  return {
    client,
    spawned,
    reused,
    requestedPort: options.requestedPort,
    actualPort: options.requestedPort,
    diagnostic,
  };
}

export async function diagnoseOAuthBroker(
  input: OAuthBrokerBootstrapOptions,
): Promise<OAuthBrokerLaunchDiagnostic> {
  return diagnose(resolveOptions(input));
}

async function diagnose(options: ResolvedBootstrapOptions): Promise<OAuthBrokerLaunchDiagnostic> {
  let lockHeld: boolean | "unknown";
  try {
    lockHeld = await isOAuthBrokerLockHeld(options.rootDir, { staleMs: options.lockStaleMs });
  } catch (error) {
    options.onWarning?.("OAuth broker lock status could not be determined.", error);
    lockHeld = "unknown";
  }

  const portOccupied = await probePort(options.requestedPort, options.diagnosticTimeoutMs);
  let compatibleHealth = false;
  if (portOccupied === true) {
    try {
      await readAndRequestOAuthBrokerHealth(
        options.rootDir,
        options.namespaceId,
        options.requestedPort,
        { timeoutMs: options.diagnosticTimeoutMs },
      );
      compatibleHealth = true;
    } catch {
      compatibleHealth = false;
    }
  }

  return { lockHeld, portOccupied, compatibleHealth };
}

function diagnosticWarning(diagnostic: OAuthBrokerLaunchDiagnostic): string {
  if (diagnostic.lockHeld === true && diagnostic.portOccupied === true) {
    return diagnostic.compatibleHealth
      ? "Reusing the compatible OAuth broker on the configured port."
      : "An OAuth broker lock and configured port are occupied, but compatible health could not be confirmed; OAuth remains unavailable until reload.";
  }
  if (diagnostic.lockHeld === true) {
    return "The OAuth broker lock is held while the configured port is not available; an old broker or startup race may need reload.";
  }
  if (diagnostic.portOccupied === true) {
    return "The configured OAuth broker port is occupied by an unknown process; no fallback port will be selected.";
  }
  return "OAuth broker startup diagnostics were inconclusive; OAuth remains unavailable until reload.";
}

function spawnBroker(options: ResolvedBootstrapOptions): ChildProcess {
  try {
    const child = spawn(process.execPath, [
      options.brokerEntrypoint,
      "--root", options.rootDir,
      "--namespace", options.namespaceId,
      "--port", String(options.requestedPort),
      "--presence-ttl-ms", String(options.presenceTtlMs),
      "--idle-grace-ms", String(options.idleGraceMs),
      "--lock-stale-ms", String(options.lockStaleMs),
      "--lock-update-ms", String(options.lockUpdateMs),
    ], {
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    child.unref();
    return child;
  } catch (error) {
    throw new OAuthBrokerBootstrapError(
      "broker-spawn-failed",
      "OAuth broker process could not be spawned.",
      { cause: error },
    );
  }
}

async function probePort(port: number, timeoutMs: number): Promise<boolean | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      return "unknown";
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveOptions(input: OAuthBrokerBootstrapOptions): ResolvedBootstrapOptions {
  if (typeof input.rootDir !== "string" || input.rootDir.trim().length === 0) {
    throw new OAuthBrokerBootstrapError("invalid-options", "OAuth broker rootDir must be non-empty.");
  }
  if (typeof input.namespaceId !== "string" || input.namespaceId.trim().length === 0) {
    throw new OAuthBrokerBootstrapError("invalid-options", "OAuth broker namespaceId must be non-empty.");
  }
  const requestedPort = assertOAuthBrokerPort(
    input.requestedPort ?? DEFAULT_OAUTH_BROKER_PORT,
    "requestedPort",
  );
  const requestTimeoutMs = requirePositiveFinite(
    input.requestTimeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const diagnosticTimeoutMs = requirePositiveFinite(
    input.diagnosticTimeoutMs ?? Math.min(requestTimeoutMs, 500),
    "diagnosticTimeoutMs",
  );
  const reconnectIntervalMs = requirePositiveFinite(
    input.reconnectIntervalMs ?? DEFAULT_OAUTH_BROKER_RECONNECT_INTERVAL_MS,
    "reconnectIntervalMs",
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
  const lockStaleMs = requirePositiveFinite(
    input.lockStaleMs ?? DEFAULT_OAUTH_BROKER_LOCK_STALE_MS,
    "lockStaleMs",
  );
  const lockUpdateMs = requirePositiveFinite(
    input.lockUpdateMs ?? DEFAULT_OAUTH_BROKER_LOCK_UPDATE_MS,
    "lockUpdateMs",
  );
  if (presencePulseMs >= presenceTtlMs) {
    throw new OAuthBrokerBootstrapError("invalid-options", "presencePulseMs must be smaller than presenceTtlMs.");
  }
  if (lockUpdateMs > lockStaleMs / 2) {
    throw new OAuthBrokerBootstrapError("invalid-options", "lockUpdateMs must not exceed half of lockStaleMs.");
  }
  return {
    rootDir: input.rootDir,
    namespaceId: input.namespaceId.trim(),
    requestedPort,
    requestTimeoutMs,
    diagnosticTimeoutMs,
    reconnectIntervalMs,
    presencePulseMs,
    presenceTtlMs,
    idleGraceMs,
    lockStaleMs,
    lockUpdateMs,
    brokerEntrypoint: input.brokerEntrypoint ?? DEFAULT_BROKER_ENTRYPOINT,
    client: input.client,
    signal: input.signal,
    onWarning: input.onWarning,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OAuthBrokerBootstrapError("bootstrap-aborted", "OAuth broker bootstrap was aborted.", {
      cause: signal.reason,
    });
  }
}

function requirePositiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new OAuthBrokerBootstrapError("invalid-options", `${fieldName} must be positive.`);
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
