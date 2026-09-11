import { randomUUID } from "node:crypto";
import {
  createOAuthBrokerRequestEnvelope,
  DEFAULT_OAUTH_BROKER_CONNECT_TIMEOUT_MS,
  DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
  DEFAULT_OAUTH_BROKER_RECONNECT_INTERVAL_MS,
  DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
  getOAuthBrokerUrl,
  OAUTH_BROKER_PRESENCE_ID_HEADER,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  OAUTH_BROKER_SESSION_ID_HEADER,
  parseOAuthBrokerAccessDescriptor,
  parseOAuthBrokerHealth,
  parseOAuthBrokerLogoutResult,
  parseOAuthBrokerResponseEnvelope,
  parseOAuthBrokerStatusResult,
  parseOAuthBrokerTokenResult,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerHealth,
  type OAuthBrokerIdentityRequest,
  type OAuthBrokerLogoutRequest,
  type OAuthBrokerLogoutResult,
  type OAuthBrokerPresenceAction,
  type OAuthBrokerPresenceIdentity,
  type OAuthBrokerPresenceRequest,
  type OAuthBrokerStatusResult,
  type OAuthBrokerTokenRequest,
  type OAuthBrokerTokenResult,
} from "./protocol.ts";
import { readOAuthBrokerAccess } from "./runtime-files.ts";

export type OAuthBrokerClientState =
  | "new"
  | "disconnected"
  | "connecting"
  | "connected"
  | "frozen"
  | "closed";

export type OAuthBrokerClientErrorCode =
  | "broker-client-closed"
  | "broker-client-frozen"
  | "broker-request-aborted"
  | "broker-timeout"
  | "broker-unavailable"
  | "broker-protocol-error"
  | "broker-remote-error"
  | "broker-access-invalid";

export class OAuthBrokerClientError extends Error {
  readonly code: OAuthBrokerClientErrorCode;
  readonly status?: number;
  readonly remoteCode?: string;

  constructor(
    code: OAuthBrokerClientErrorCode,
    message: string,
    options: { cause?: unknown; status?: number; remoteCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthBrokerClientError";
    this.code = code;
    this.status = options.status;
    this.remoteCode = options.remoteCode;
  }
}

export interface OAuthBrokerClientOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly configuredPort: number;
  readonly sessionId?: string;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly reconnectIntervalMs?: number;
  readonly presencePulseMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onStateChange?: (state: OAuthBrokerClientState) => void;
}

export interface OAuthBrokerRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OAuthBrokerCallOptions extends OAuthBrokerRequestOptions {
  readonly method?: "GET" | "POST";
  readonly params?: unknown;
}

interface LowLevelRequestOptions extends OAuthBrokerCallOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly presence?: OAuthBrokerPresenceIdentity;
}

// Node clamps larger timeout delays; long custom pulse intervals are scheduled in chunks.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Session-scoped broker client. It owns only the session presence and a
 * replaceable access snapshot; it never starts a broker process itself.
 */
export class OAuthBrokerClient {
  readonly sessionId: string;

  private readonly rootDir: string;
  private readonly namespaceId: string;
  private readonly configuredPort: number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly presencePulseMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly onStateChange?: (state: OAuthBrokerClientState) => void;

  private lifecycle: OAuthBrokerClientState = "new";
  private generation = 0;
  private access: OAuthBrokerAccessDescriptor | undefined;
  private presenceId: string | undefined;
  private lastActivityAt = 0;
  private activityRevision = 0;
  private ensureConnectedFlight: Promise<void> | undefined;
  private pulseFlight: Promise<void> | undefined;
  private pulseTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setInterval> | undefined;
  private closeFlight: Promise<void> | undefined;

  constructor(options: OAuthBrokerClientOptions) {
    this.rootDir = requireNonEmpty(options.rootDir, "rootDir");
    this.namespaceId = requireNonEmpty(options.namespaceId, "namespaceId");
    this.configuredPort = requirePort(options.configuredPort, "configuredPort");
    this.sessionId = options.sessionId ?? randomUUID();
    this.requestTimeoutMs = requirePositiveFinite(
      options.requestTimeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.connectTimeoutMs = requirePositiveFinite(
      options.connectTimeoutMs ?? DEFAULT_OAUTH_BROKER_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.reconnectIntervalMs = requirePositiveFinite(
      options.reconnectIntervalMs ?? DEFAULT_OAUTH_BROKER_RECONNECT_INTERVAL_MS,
      "reconnectIntervalMs",
    );
    this.presencePulseMs = requirePositiveFinite(
      options.presencePulseMs ?? DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
      "presencePulseMs",
    );
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.onStateChange = options.onStateChange;
  }

  get state(): OAuthBrokerClientState {
    return this.lifecycle;
  }

  get connected(): boolean {
    return this.lifecycle === "connected";
  }

  get currentPresenceId(): string | undefined {
    return this.presenceId;
  }

  /** Starts background reconnect/heartbeat work without waiting for broker readiness. */
  start(): void {
    if (this.lifecycle === "new") {
      this.setState("disconnected");
    }
    this.startReconnectTimer();
    void this.ensureConnected().catch(() => undefined);
  }

  /** Shared connection attempt. Callers may cancel their own wait without cancelling the flight. */
  ensureConnected(options: OAuthBrokerRequestOptions = {}): Promise<void> {
    this.assertUsable();
    if (this.lifecycle === "connected") {
      return withCallerAbort(Promise.resolve(), options.signal);
    }
    if (!this.ensureConnectedFlight) {
      const generation = this.generation;
      this.setState("connecting");
      const flight = this.connect(generation);
      this.ensureConnectedFlight = flight;
      flight.then(
        () => this.clearEnsureFlight(flight),
        () => this.clearEnsureFlight(flight),
      );
    }
    return withCallerAbort(this.ensureConnectedFlight, options.signal);
  }

  async health(options: OAuthBrokerRequestOptions = {}): Promise<OAuthBrokerHealth> {
    this.assertUsable();
    const access = this.access ?? await this.readUsableAccess();
    return requestOAuthBrokerHealth(access, {
      ...options,
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
      fetch: this.fetchImplementation,
    });
  }

  async getOAuthStatus(
    params: OAuthBrokerIdentityRequest,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerStatusResult> {
    const result = await this.request<unknown>(OAUTH_BROKER_ROUTES.oauthStatus, {
      method: "POST",
      params,
      ...options,
    });
    return parseOAuthBrokerStatusResult(result);
  }

  async getOAuthToken(
    params: OAuthBrokerTokenRequest,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerTokenResult> {
    const result = await this.request<unknown>(OAUTH_BROKER_ROUTES.oauthToken, {
      method: "POST",
      params,
      ...options,
    });
    return parseOAuthBrokerTokenResult(result);
  }

  async logoutOAuth(
    params: OAuthBrokerLogoutRequest,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerLogoutResult> {
    const result = await this.request<unknown>(OAUTH_BROKER_ROUTES.oauthLogout, {
      method: "POST",
      params,
      ...options,
    });
    return parseOAuthBrokerLogoutResult(result);
  }

  /** Sends a future broker API request and counts a successful response as liveness. */
  async request<T = unknown>(
    pathname: string,
    options: OAuthBrokerCallOptions = {},
  ): Promise<T> {
    this.assertUsable();
    await this.ensureConnected({ signal: options.signal });
    const generation = this.generation;
    const access = this.access;
    const presenceId = this.presenceId;
    if (!access || !presenceId || this.lifecycle !== "connected") {
      throw new OAuthBrokerClientError(
        "broker-unavailable",
        "OAuth broker presence is not connected.",
      );
    }

    try {
      const result = await requestOAuthBrokerJson<T>(access, pathname, {
        ...options,
        presence: { sessionId: this.sessionId, presenceId },
        timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
        fetch: this.fetchImplementation,
      });
      if (this.generation === generation && this.lifecycle === "connected") {
        this.noteActivity();
      }
      return result;
    } catch (error) {
      if (this.generation === generation && shouldDisconnect(error)) {
        this.markDisconnected();
      }
      throw error;
    }
  }

  /** Allows the current session to reconnect later while releasing this presence now. */
  async disconnect(): Promise<void> {
    if (this.lifecycle === "closed" || this.lifecycle === "frozen") {
      return;
    }
    await this.transitionAway("disconnected");
    this.startReconnectTimer();
  }

  /** Freezes the client. Late connection/pulse results cannot restore it. */
  freeze(): Promise<void> {
    if (this.lifecycle === "frozen" || this.lifecycle === "closed") {
      return Promise.resolve();
    }
    return this.transitionAway("frozen");
  }

  close(): Promise<void> {
    if (this.closeFlight) {
      return this.closeFlight;
    }
    this.closeFlight = (async () => {
      if (this.lifecycle !== "closed") {
        await this.transitionAway("closed");
      }
    })();
    return this.closeFlight;
  }

  private async connect(generation: number): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: unknown;

    try {
      while (Date.now() < deadline) {
        this.assertConnectionGeneration(generation);
        try {
          const access = await this.readUsableAccess();
          const presenceId = randomUUID();
          await sendPresence(access, this.sessionId, presenceId, "register", {
            timeoutMs: this.requestTimeoutMs,
            fetch: this.fetchImplementation,
          });
          if (this.generation !== generation || this.lifecycle === "frozen" || this.lifecycle === "closed") {
            await sendPresence(access, this.sessionId, presenceId, "release", {
              timeoutMs: this.requestTimeoutMs,
              fetch: this.fetchImplementation,
            }).catch(() => undefined);
            this.assertConnectionGeneration(generation);
          }
          this.access = access;
          this.presenceId = presenceId;
          this.setState("connected");
          this.noteActivity();
          return;
        } catch (error) {
          lastError = error;
          if (!isRetryableConnectionError(error)) {
            throw error;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            break;
          }
          await sleep(Math.min(this.reconnectIntervalMs, remaining));
        }
      }

      throw lastError ?? new OAuthBrokerClientError(
        "broker-timeout",
        `OAuth broker connection timed out after ${this.connectTimeoutMs} ms.`,
      );
    } catch (error) {
      if (this.generation === generation && this.lifecycle !== "closed" && this.lifecycle !== "frozen") {
        this.access = undefined;
        this.presenceId = undefined;
        this.setState("disconnected");
        this.startReconnectTimer();
      }
      throw error;
    }
  }

  private assertConnectionGeneration(generation: number): void {
    if (this.generation !== generation || this.lifecycle === "closed") {
      throw new OAuthBrokerClientError("broker-client-closed", "OAuth broker client connection was superseded.");
    }
    if (this.lifecycle === "frozen") {
      throw new OAuthBrokerClientError("broker-client-frozen", "OAuth broker client is frozen.");
    }
  }

  private async transitionAway(nextState: "disconnected" | "frozen" | "closed"): Promise<void> {
    const previousAccess = this.access;
    const previousPresenceId = this.presenceId;
    this.generation += 1;
    this.stopTimers();
    this.access = undefined;
    this.presenceId = undefined;
    this.setState(nextState);
    if (previousAccess && previousPresenceId) {
      await sendPresence(previousAccess, this.sessionId, previousPresenceId, "release", {
        timeoutMs: this.requestTimeoutMs,
        fetch: this.fetchImplementation,
      }).catch(() => undefined);
    }
  }

  private markDisconnected(): void {
    if (this.lifecycle !== "connected") {
      return;
    }
    void this.transitionAway("disconnected").finally(() => this.startReconnectTimer());
  }

  private schedulePulse(): void {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }
    if (this.lifecycle !== "connected") {
      return;
    }

    const remainingMs = this.lastActivityAt + this.presencePulseMs - Date.now();
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remainingMs));
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      this.sendPulseIfDue();
    }, delayMs);
    this.pulseTimer.unref?.();
  }

  private sendPulseIfDue(): void {
    if (this.lifecycle !== "connected" || this.pulseFlight) {
      return;
    }
    if (Date.now() - this.lastActivityAt < this.presencePulseMs) {
      this.schedulePulse();
      return;
    }

    const access = this.access;
    const presenceId = this.presenceId;
    const generation = this.generation;
    const activityRevision = this.activityRevision;
    if (!access || !presenceId) {
      this.markDisconnected();
      return;
    }

    const flight = sendPresence(access, this.sessionId, presenceId, "pulse", {
      timeoutMs: this.requestTimeoutMs,
      fetch: this.fetchImplementation,
    }).then(() => undefined);
    this.pulseFlight = flight;
    flight.then(
      () => {
        if (this.pulseFlight === flight) {
          this.pulseFlight = undefined;
        }
        if (this.generation === generation && this.lifecycle === "connected") {
          this.noteActivity();
        }
      },
      () => {
        if (this.pulseFlight === flight) {
          this.pulseFlight = undefined;
        }
        if (this.generation === generation && this.lifecycle === "connected") {
          if (this.activityRevision !== activityRevision) {
            this.schedulePulse();
          } else {
            this.markDisconnected();
          }
        }
      },
    );
  }

  private startReconnectTimer(): void {
    if (this.reconnectTimer || this.lifecycle === "closed" || this.lifecycle === "frozen") {
      return;
    }
    this.reconnectTimer = setInterval(() => {
      if (this.lifecycle === "disconnected") {
        void this.ensureConnected().catch(() => undefined);
      }
    }, this.reconnectIntervalMs);
    this.reconnectTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.activityRevision += 1;
    this.schedulePulse();
  }

  private clearEnsureFlight(flight: Promise<void>): void {
    if (this.ensureConnectedFlight === flight) {
      this.ensureConnectedFlight = undefined;
    }
  }

  private async readUsableAccess(): Promise<OAuthBrokerAccessDescriptor> {
    let access: OAuthBrokerAccessDescriptor | undefined;
    try {
      access = await readOAuthBrokerAccess(this.rootDir);
    } catch (error) {
      throw new OAuthBrokerClientError(
        "broker-access-invalid",
        "OAuth broker access file is invalid.",
        { cause: error },
      );
    }
    if (!access) {
      throw new OAuthBrokerClientError(
        "broker-unavailable",
        "OAuth broker access file is not available; reload the Pi session to bootstrap it.",
      );
    }
    if (access.namespaceId !== this.namespaceId || access.port !== this.configuredPort) {
      throw new OAuthBrokerClientError(
        "broker-access-invalid",
        "OAuth broker access file does not match the configured namespace or port.",
      );
    }
    return access;
  }

  private setState(state: OAuthBrokerClientState): void {
    if (this.lifecycle === state) {
      return;
    }
    this.lifecycle = state;
    try {
      this.onStateChange?.(state);
    } catch {
      // A notification sink must not break broker lifecycle management.
    }
  }

  private assertUsable(): void {
    if (this.lifecycle === "closed") {
      throw new OAuthBrokerClientError("broker-client-closed", "OAuth broker client is closed.");
    }
    if (this.lifecycle === "frozen") {
      throw new OAuthBrokerClientError("broker-client-frozen", "OAuth broker client is frozen.");
    }
  }
}

export async function requestOAuthBrokerHealth(
  access: OAuthBrokerAccessDescriptor,
  options: OAuthBrokerRequestOptions & { fetch?: typeof globalThis.fetch } = {},
): Promise<OAuthBrokerHealth> {
  const result = await requestOAuthBrokerJson<unknown>(access, OAUTH_BROKER_ROUTES.health, {
    method: "GET",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
  });
  const health = parseOAuthBrokerHealth(result);
  assertHealthMatchesAccess(health, access);
  return health;
}

function assertHealthMatchesAccess(
  health: OAuthBrokerHealth,
  access: OAuthBrokerAccessDescriptor,
): void {
  if (health.namespaceId !== access.namespaceId
    || health.instanceId !== access.instanceId
    || health.port !== access.port
    || health.startedAt !== access.startedAt) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      "OAuth broker health response does not match the access file.",
    );
  }
}

export async function readAndRequestOAuthBrokerHealth(
  rootDir: string,
  namespaceId: string,
  configuredPort: number,
  options: OAuthBrokerRequestOptions & { fetch?: typeof globalThis.fetch } = {},
): Promise<OAuthBrokerHealth> {
  let access: OAuthBrokerAccessDescriptor | undefined;
  try {
    access = await readOAuthBrokerAccess(rootDir);
  } catch (error) {
    throw new OAuthBrokerClientError("broker-access-invalid", "OAuth broker access file is invalid.", { cause: error });
  }
  if (!access || access.namespaceId !== namespaceId || access.port !== configuredPort) {
    throw new OAuthBrokerClientError("broker-unavailable", "No compatible OAuth broker access snapshot is available.");
  }
  return requestOAuthBrokerHealth(access, options);
}

export async function requestOAuthBrokerJson<T = unknown>(
  access: OAuthBrokerAccessDescriptor,
  pathname: string,
  options: LowLevelRequestOptions = {},
): Promise<T> {
  const requestId = randomUUID();
  const timeoutMs = requirePositiveFinite(
    options.timeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    "timeoutMs",
  );
  const controller = new AbortController();
  const throwFailure = (error: unknown): never => {
    if (error instanceof OAuthBrokerRequestAbortedError || options.signal?.aborted) {
      throw new OAuthBrokerClientError("broker-request-aborted", "OAuth broker request was aborted by the caller.", { cause: error });
    }
    if (error instanceof OAuthBrokerRequestTimeoutError) {
      throw new OAuthBrokerClientError("broker-timeout", `OAuth broker request timed out after ${timeoutMs} ms.`, { cause: error });
    }
    throw new OAuthBrokerClientError(
      "broker-unavailable",
      "OAuth broker is unavailable; reload the Pi session to bootstrap it again.",
      { cause: error },
    );
  };

  let response: Response;
  try {
    response = await waitForRequestPart(() => (options.fetch ?? globalThis.fetch)(
      getOAuthBrokerUrl(access.port, pathname),
      {
        method: options.method ?? "GET",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${access.secret}`,
          [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId,
          ...(options.presence === undefined ? {} : {
            [OAUTH_BROKER_SESSION_ID_HEADER]: options.presence.sessionId,
            [OAUTH_BROKER_PRESENCE_ID_HEADER]: options.presence.presenceId,
          }),
          ...(options.params === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.params === undefined
          ? undefined
          : JSON.stringify(createOAuthBrokerRequestEnvelope(requestId, options.params)),
        },
      ), controller, timeoutMs, options.signal);
  } catch (error) {
    return throwFailure(error);
  }

  let responseText: string;
  try {
    responseText = await waitForRequestPart(
      () => response.text(),
      controller,
      timeoutMs,
      options.signal,
    );
  } catch (error) {
    return throwFailure(error);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new OAuthBrokerClientError("broker-protocol-error", "OAuth broker returned invalid JSON.", {
      cause: error,
      status: response.status,
    });
  }

  let envelope;
  try {
    envelope = parseOAuthBrokerResponseEnvelope(payload, requestId);
  } catch (error) {
    throw new OAuthBrokerClientError("broker-protocol-error", "OAuth broker returned an invalid response envelope.", {
      cause: error,
      status: response.status,
    });
  }
  if (!envelope.ok) {
    throw new OAuthBrokerClientError("broker-remote-error", envelope.error.message, {
      status: response.status,
      remoteCode: envelope.error.code,
    });
  }
  if (!response.ok) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      `OAuth broker returned HTTP ${response.status} with a success envelope.`,
      { status: response.status },
    );
  }
  return envelope.result as T;
}

class OAuthBrokerRequestTimeoutError extends Error {
  constructor() {
    super("OAuth broker request timed out.");
    this.name = "OAuthBrokerRequestTimeoutError";
  }
}

class OAuthBrokerRequestAbortedError extends Error {
  constructor() {
    super("OAuth broker request was aborted.");
    this.name = "OAuthBrokerRequestAbortedError";
  }
}

function waitForRequestPart<T>(
  operation: () => PromiseLike<T>,
  controller: AbortController,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onCallerAbort = () => {
      controller.abort(callerSignal?.reason);
      settle(() => reject(new OAuthBrokerRequestAbortedError()));
    };

    timer = setTimeout(() => {
      controller.abort();
      settle(() => reject(new OAuthBrokerRequestTimeoutError()));
    }, timeoutMs);

    if (callerSignal?.aborted) {
      onCallerAbort();
      return;
    }
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      );
  });
}

async function sendPresence(
  access: OAuthBrokerAccessDescriptor,
  sessionId: string,
  presenceId: string,
  action: OAuthBrokerPresenceAction,
  options: LowLevelRequestOptions,
): Promise<OAuthBrokerHealth> {
  const params: OAuthBrokerPresenceRequest = { action, sessionId, presenceId };
  const result = await requestOAuthBrokerJson<unknown>(access, OAUTH_BROKER_ROUTES.presence, {
    method: "POST",
    params,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetch: options.fetch,
  });
  const health = parseOAuthBrokerHealth(result);
  assertHealthMatchesAccess(health, access);
  return health;
}

function shouldDisconnect(error: unknown): boolean {
  return error instanceof OAuthBrokerClientError && (
    error.code === "broker-timeout"
    || error.code === "broker-unavailable"
    || error.code === "broker-protocol-error"
    || error.code === "broker-access-invalid"
  );
}

function isRetryableConnectionError(error: unknown): boolean {
  return error instanceof OAuthBrokerClientError && (
    error.code === "broker-unavailable"
    || error.code === "broker-timeout"
    || error.code === "broker-remote-error"
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function withCallerAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new OAuthBrokerClientError("broker-request-aborted", "OAuth broker wait was aborted by the caller.", { cause: signal.reason }));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new OAuthBrokerClientError("broker-request-aborted", "OAuth broker wait was aborted by the caller.", { cause: signal.reason }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function requirePort(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${fieldName} must be an integer from 1 to 65535.`);
  }
  return value;
}

function requirePositiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive finite number.`);
  }
  return value;
}
