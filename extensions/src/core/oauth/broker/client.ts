import { randomUUID } from "node:crypto";
import {
  createOAuthBrokerRequestEnvelope,
  DEFAULT_OAUTH_BROKER_AUTHORIZE_CALLER_MARGIN_MS,
  DEFAULT_OAUTH_BROKER_AUTHORIZE_TIMEOUT_MS,
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
  parseOAuthBrokerAuthorizeResult,
  parseOAuthBrokerHealth,
  parseOAuthBrokerLogoutResult,
  parseOAuthBrokerScopeChallengeResult,
  parseOAuthBrokerResponseEnvelope,
  parseOAuthBrokerStatusResult,
  parseOAuthBrokerTokenResult,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerAuthorizeRequest,
  type OAuthBrokerAuthorizeResult,
  type OAuthBrokerHealth,
  type OAuthBrokerIdentityRequest,
  type OAuthBrokerLogoutRequest,
  type OAuthBrokerLogoutResult,
  type OAuthBrokerScopeChallengeRequest,
  type OAuthBrokerScopeChallengeResult,
  type OAuthBrokerPresenceAction,
  type OAuthBrokerPresenceIdentity,
  type OAuthBrokerPresenceRequest,
  type OAuthBrokerStatusResult,
  type OAuthBrokerTokenRequest,
  type OAuthBrokerTokenResult,
} from "./protocol.ts";
import { readOAuthBrokerAccess } from "./runtime-files.ts";
import type { OAuthCapability } from "../capability.ts";

export type OAuthBrokerClientState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "closed";

export type OAuthBrokerClientErrorCode =
  | "broker-client-closed"
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
  /** authorize 是长请求；默认超时时间为事务超时加少量回调/交换余量。 */
  readonly authorizeTimeoutMs?: number;
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

// Node 对过大的定时器延迟会进行截断；较长的自定义 pulse 间隔需要分段调度。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * session 级 broker client。它只拥有当前 session 的 presence 和可替换的
 * access 快照，不会自行启动 broker 进程。
 */
export class OAuthBrokerClient implements OAuthCapability {
  readonly sessionId: string;

  private readonly rootDir: string;
  private readonly namespaceId: string;
  private readonly configuredPort: number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly presencePulseMs: number;
  private readonly authorizeTimeoutMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly onStateChange?: (state: OAuthBrokerClientState) => void;

  private lifecycle: OAuthBrokerClientState = "disconnected";
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
    this.authorizeTimeoutMs = requirePositiveFinite(
      options.authorizeTimeoutMs
        ?? DEFAULT_OAUTH_BROKER_AUTHORIZE_TIMEOUT_MS + DEFAULT_OAUTH_BROKER_AUTHORIZE_CALLER_MARGIN_MS,
      "authorizeTimeoutMs",
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

  /** 在不等待 broker 就绪的情况下启动后台重连和 heartbeat。 */
  start(): void {
    this.startReconnectTimer();
    void this.ensureConnected().catch(() => undefined);
  }

  /** 共享连接尝试。调用方可以取消自己的等待，但不会取消共享 flight。 */
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

  /**
   * 转发 403 `insufficient_scope` 的 scope challenge。challenged scope 已在追加集合中时
   * broker 返回 409 `scope-not-grantable`，表示无法通过重复授权循环满足。
   */
  async challengeScope(
    params: OAuthBrokerScopeChallengeRequest,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerScopeChallengeResult> {
    const result = await this.request<unknown>(OAUTH_BROKER_ROUTES.oauthScopeChallenge, {
      method: "POST",
      params,
      ...options,
    });
    return parseOAuthBrokerScopeChallengeResult(result);
  }

  /**
   * 打开交互式授权流程。broker 会让 HTTP 响应保持 pending，直到事务进入终态，
   * 因此本调用使用专用的长请求超时，除非调用方显式覆盖该超时。
   */
  async authorizeOAuth(
    params: OAuthBrokerAuthorizeRequest,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerAuthorizeResult> {
    const result = await this.request<unknown>(OAUTH_BROKER_ROUTES.oauthAuthorize, {
      method: "POST",
      params,
      ...options,
      timeoutMs: options.timeoutMs ?? this.authorizeTimeoutMs,
    });
    return parseOAuthBrokerAuthorizeResult(result);
  }

  /** 发送 broker API 请求，并将成功响应计为一次存活确认。 */
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

  /** 释放当前 presence，同时允许当前 session 之后重新连接。 */
  async disconnect(): Promise<void> {
    if (this.lifecycle === "closed") {
      return;
    }
    await this.transitionAway("disconnected");
    this.startReconnectTimer();
  }

  /** 关闭 client，使迟到的生命周期结果失效，并释放当前 presence。 */
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
          if (this.generation !== generation || this.lifecycle === "closed") {
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
      if (this.generation === generation && this.lifecycle !== "closed") {
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
  }

  private async transitionAway(nextState: "disconnected" | "closed"): Promise<void> {
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
    if (this.reconnectTimer || this.lifecycle === "closed") {
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
      // 通知 sink 不能破坏 broker 生命周期管理。
    }
  }

  private assertUsable(): void {
    if (this.lifecycle === "closed") {
      throw new OAuthBrokerClientError("broker-client-closed", "OAuth broker client is closed.");
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
