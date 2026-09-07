import { randomUUID } from "node:crypto";
import {
  assertOAuthBrokerPublication,
  createOAuthBrokerRequestEnvelope,
  DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
  DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
  getOAuthBrokerUrl,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  parseOAuthBrokerHealth,
  parseOAuthBrokerResponseEnvelope,
  type OAuthBrokerEndpointDescriptor,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerHealth,
  type OAuthBrokerPresenceAction,
  type OAuthBrokerPresenceRequest,
  type OAuthBrokerPublication,
} from "./protocol.ts";

export type OAuthBrokerClientErrorCode =
  | "broker-client-closed"
  | "broker-request-aborted"
  | "broker-timeout"
  | "broker-unavailable"
  | "broker-protocol-error"
  | "broker-remote-error";

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
  readonly publication: OAuthBrokerPublication;
  readonly sessionId?: string;
  readonly requestTimeoutMs?: number;
  readonly presencePulseMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface OAuthBrokerRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface JsonRequestOptions extends OAuthBrokerRequestOptions {
  readonly method?: "GET" | "POST";
  readonly params?: unknown;
}

/**
 * 单个 Pi session 持有的轻量 broker client。它只持有 endpoint/access snapshot 和
 * presence timer，不缓存 broker 全局 availability，也不会自行重启 broker。
 */
export class OAuthBrokerClient {
  readonly endpoint: OAuthBrokerEndpointDescriptor;
  readonly sessionId: string;

  private readonly access: OAuthBrokerAccessDescriptor;
  private readonly requestTimeoutMs: number;
  private readonly presencePulseMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private lifecycle: "new" | "active" | "closed" = "new";
  private registered = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private pulseTimer: ReturnType<typeof setInterval> | undefined;
  private pulseFlight: Promise<void> | undefined;

  constructor(options: OAuthBrokerClientOptions) {
    const publication = assertOAuthBrokerPublication(options.publication);
    this.endpoint = { ...publication.endpoint };
    this.access = { ...publication.access };
    this.sessionId = options.sessionId ?? randomUUID();
    this.requestTimeoutMs = requirePositiveFinite(
      options.requestTimeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.presencePulseMs = requirePositiveFinite(
      options.presencePulseMs ?? DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS,
      "presencePulseMs",
    );
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  get active(): boolean {
    return this.lifecycle === "active";
  }

  async start(options: OAuthBrokerRequestOptions = {}): Promise<void> {
    if (this.lifecycle === "active") {
      return;
    }
    if (this.lifecycle === "closed") {
      throw new OAuthBrokerClientError("broker-client-closed", "OAuth broker client is closed.");
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.sendPresence("register", options).then(() => {
      this.registered = true;
      if (this.lifecycle !== "closed") {
        this.lifecycle = "active";
        this.startPulseTimer();
      }
    });

    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  async health(options: OAuthBrokerRequestOptions = {}): Promise<OAuthBrokerHealth> {
    this.assertOpen();
    return requestOAuthBrokerHealth(this.publication(), {
      ...options,
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
      fetch: this.fetchImplementation,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.lifecycle = "closed";
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = undefined;
    }

    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.pulseFlight?.catch(() => undefined);
      if (this.registered) {
        await this.sendPresence("release").catch(() => undefined);
        this.registered = false;
      }
    })();
    return this.closePromise;
  }

  private publication(): OAuthBrokerPublication {
    return {
      endpoint: this.endpoint,
      access: this.access,
    };
  }

  private assertOpen(): void {
    if (this.lifecycle === "closed") {
      throw new OAuthBrokerClientError("broker-client-closed", "OAuth broker client is closed.");
    }
  }

  private startPulseTimer(): void {
    this.pulseTimer = setInterval(() => {
      if (this.lifecycle !== "active" || this.pulseFlight) {
        return;
      }
      const flight = this.sendPresence("pulse").then(() => undefined);
      this.pulseFlight = flight;
      flight.then(
        () => this.clearPulseFlight(flight),
        () => this.clearPulseFlight(flight),
      );
    }, this.presencePulseMs);
    this.pulseTimer.unref?.();
  }

  private clearPulseFlight(flight: Promise<void>): void {
    if (this.pulseFlight === flight) {
      this.pulseFlight = undefined;
    }
  }

  private async sendPresence(
    action: OAuthBrokerPresenceAction,
    options: OAuthBrokerRequestOptions = {},
  ): Promise<OAuthBrokerHealth> {
    const params: OAuthBrokerPresenceRequest = { action, sessionId: this.sessionId };
    const result = await requestOAuthBrokerJson(
      this.publication(),
      OAUTH_BROKER_ROUTES.presence,
      {
        method: "POST",
        params,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
        fetch: this.fetchImplementation,
      },
    );
    return assertHealthMatchesEndpoint(parseOAuthBrokerHealth(result), this.endpoint);
  }
}

interface LowLevelRequestOptions extends JsonRequestOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export async function requestOAuthBrokerHealth(
  publication: OAuthBrokerPublication,
  options: OAuthBrokerRequestOptions & { fetch?: typeof globalThis.fetch } = {},
): Promise<OAuthBrokerHealth> {
  const parsed = assertOAuthBrokerPublication(publication);
  const result = await requestOAuthBrokerJson(parsed, OAUTH_BROKER_ROUTES.health, {
    method: "GET",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
  });
  return assertHealthMatchesEndpoint(parseOAuthBrokerHealth(result), parsed.endpoint);
}

async function requestOAuthBrokerJson(
  publication: OAuthBrokerPublication,
  pathname: string,
  options: LowLevelRequestOptions,
): Promise<unknown> {
  const requestId = randomUUID();
  const timeoutMs = requirePositiveFinite(
    options.timeoutMs ?? DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS,
    "timeoutMs",
  );
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const cleanupRequest = () => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };
  const throwRequestFailure = (error: unknown): never => {
    if (options.signal?.aborted) {
      throw new OAuthBrokerClientError(
        "broker-request-aborted",
        "OAuth broker request was aborted by the caller.",
        { cause: error },
      );
    }
    if (timedOut) {
      throw new OAuthBrokerClientError(
        "broker-timeout",
        `OAuth broker request timed out after ${timeoutMs} ms.`,
        { cause: error },
      );
    }
    throw new OAuthBrokerClientError(
      "broker-unavailable",
      "OAuth broker is unavailable; reload the Pi session to bootstrap it again.",
      { cause: error },
    );
  };

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      getOAuthBrokerUrl(publication.endpoint, pathname),
      {
        method: options.method ?? "GET",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${publication.access.secret}`,
          [OAUTH_BROKER_REQUEST_ID_HEADER]: requestId,
          ...(options.params === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.params === undefined
          ? undefined
          : JSON.stringify(createOAuthBrokerRequestEnvelope(requestId, options.params)),
      },
    );
  } catch (error) {
    cleanupRequest();
    return throwRequestFailure(error);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    cleanupRequest();
    return throwRequestFailure(error);
  }
  cleanupRequest();

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      "OAuth broker returned an invalid JSON response.",
      { cause: error, status: response.status },
    );
  }

  let envelope;
  try {
    envelope = parseOAuthBrokerResponseEnvelope(payload, requestId);
  } catch (error) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      "OAuth broker returned an invalid response envelope.",
      { cause: error, status: response.status },
    );
  }

  if (!envelope.ok) {
    throw new OAuthBrokerClientError(
      "broker-remote-error",
      envelope.error.message,
      {
        status: response.status,
        remoteCode: envelope.error.code,
      },
    );
  }
  if (!response.ok) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      `OAuth broker returned HTTP ${response.status} with a success envelope.`,
      { status: response.status },
    );
  }
  return envelope.result;
}

function assertHealthMatchesEndpoint(
  health: OAuthBrokerHealth,
  endpoint: OAuthBrokerPublication["endpoint"],
): OAuthBrokerHealth {
  if (health.namespaceId !== endpoint.namespaceId
    || health.instanceId !== endpoint.instanceId
    || health.pid !== endpoint.pid
    || health.port !== endpoint.port
    || health.startedAt !== endpoint.startedAt) {
    throw new OAuthBrokerClientError(
      "broker-protocol-error",
      "OAuth broker health response does not match the discovered endpoint.",
    );
  }
  return health;
}

function requirePositiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive finite number.`);
  }
  return value;
}
