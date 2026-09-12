import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOAuthBrokerErrorEnvelope,
  createOAuthBrokerSecret,
  createOAuthBrokerSuccessEnvelope,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_PRESENCE_ID_HEADER,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  OAUTH_BROKER_SESSION_ID_HEADER,
  parseOAuthBrokerLogoutRequest,
  parseOAuthBrokerPresenceIdentity,
  parseOAuthBrokerPresenceRequest,
  parseOAuthBrokerRequestEnvelope,
  parseOAuthBrokerTokenRequest,
  parseOAuthBrokerIdentityRequest,
  parseOAuthBrokerAccessDescriptor,
  oauthBrokerSecretsEqual,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerHealth,
  type OAuthBrokerIdentityRequest,
  type OAuthBrokerLogoutRequest,
  type OAuthBrokerPresenceIdentity,
  type OAuthBrokerPresenceRequest,
  type OAuthBrokerTokenRequest,
} from "./protocol.ts";
import {
  acquireOAuthBrokerLock,
  OAuthBrokerLockError,
  type OAuthBrokerLockHandle,
} from "./lock.ts";
import {
  ensureOAuthBrokerRuntimeDirectories,
  writeOAuthBrokerAccess,
} from "./runtime-files.ts";
import {
  FileOAuthCredentialRepository,
  type OAuthCredentialRepository,
} from "./credential-repository.ts";
import {
  OAuthAuthorizationRequiredError,
  OAuthCredentialChangedError,
  OAuthScopeNotGrantedError,
  OAuthTemporaryProtocolError,
  OAuthTokenCoordinator,
  type OAuthRefreshOperation,
} from "./token-coordinator.ts";
import {
  createOAuthProtocolAdapter,
  createOAuthRefreshOperation,
} from "./oauth-protocol.ts";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface OAuthBrokerProcessOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly configuredPort: number;
  readonly presenceTtlMs: number;
  readonly idleGraceMs: number;
  readonly lockStaleMs?: number;
  readonly lockUpdateMs?: number;
  /** Test-only refresh injection; production uses the SDK-backed protocol adapter. */
  readonly refresh?: OAuthRefreshOperation;
  /** Test-only fetch injection for the SDK-backed protocol adapter. */
  readonly fetchFn?: FetchLike;
  readonly protocolTimeoutMs?: number;
  /** Test-only repository injection. Standalone brokers use the file repository. */
  readonly credentialRepository?: OAuthCredentialRepository;
  readonly now?: () => number;
}

interface PresenceRecord {
  readonly presenceId: string;
  expiresAt: number;
}

class BrokerStartupError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number) {
    super(message);
    this.name = "BrokerStartupError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runOAuthBrokerProcess(
  options: OAuthBrokerProcessOptions,
): Promise<void> {
  await ensureOAuthBrokerRuntimeDirectories(options.rootDir);

  let lock: OAuthBrokerLockHandle;
  let lockCompromised = false;
  let requestShutdown: (() => void) | undefined;
  try {
    lock = await acquireOAuthBrokerLock(options.rootDir, {
      staleMs: options.lockStaleMs,
      updateMs: options.lockUpdateMs,
      onCompromised: () => {
        lockCompromised = true;
        requestShutdown?.();
      },
    });
  } catch (error) {
    if (error instanceof OAuthBrokerLockError && error.code === "lock-unavailable") {
      throw new BrokerStartupError(
        "lock-unavailable",
        "OAuth broker runtime lock is already held.",
        17,
      );
    }
    throw error;
  }

  const repository = options.credentialRepository ?? await FileOAuthCredentialRepository
    .open(options.rootDir, options.namespaceId)
    .catch(async error => {
      await lock.release().catch(() => undefined);
      throw error;
    });
  const protocolAdapter = createOAuthProtocolAdapter({
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.protocolTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.protocolTimeoutMs }),
  });
  const tokenCoordinator = new OAuthTokenCoordinator({
    repository,
    refresh: options.refresh ?? createOAuthRefreshOperation({
      adapter: protocolAdapter,
      ...(options.now ? { now: options.now } : {}),
    }),
    discover: request => protocolAdapter.discover(request.identity.resourceUrl),
    register: request => protocolAdapter.register({
      authorizationServerUrl: request.authorizationServerUrl,
      clientMetadata: request.clientMetadata,
      ...(request.authorizationServerMetadata
        ? { metadata: request.authorizationServerMetadata }
        : {}),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
    }),
    now: options.now,
  });

  const instanceId = randomUUID();
  const secret = createOAuthBrokerSecret();
  const startedAt = Date.now();
  const sessions = new Map<string, PresenceRecord>();
  let idleDeadline: number | undefined;
  let pendingOperationCount = 0;
  let listening = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  const currentHealth = (): OAuthBrokerHealth => ({
    namespaceId: options.namespaceId,
    instanceId,
    pid: process.pid,
    port: options.configuredPort,
    startedAt,
    presenceCount: sessions.size,
    pendingOperationCount,
    idleDeadline: idleDeadline ?? null,
  });

  const clearIdleDeadline = (): void => {
    idleDeadline = undefined;
  };

  const expirePresence = (): void => {
    const now = Date.now();
    for (const [sessionId, presence] of sessions) {
      if (presence.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }
  };

  const evaluateIdle = (): void => {
    if (shuttingDown) {
      return;
    }
    expirePresence();
    if (sessions.size > 0 || pendingOperationCount > 0) {
      clearIdleDeadline();
      return;
    }
    if (idleDeadline === undefined) {
      idleDeadline = Date.now() + options.idleGraceMs;
      return;
    }
    if (Date.now() >= idleDeadline) {
      void shutdown();
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      if (!response.writableEnded && !response.destroyed) {
        sendError(
          response,
          getRequestId(request),
          500,
          "broker-internal-error",
          error instanceof Error ? error.message : "OAuth broker request failed.",
        );
      }
    });
  });

  const closeServer = (): Promise<void> => new Promise(resolveClose => {
    if (!listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeIdleConnections?.();
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolveClose();
    }, Math.max(1_000, options.idleGraceMs));
    forceTimer.unref?.();
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    shutdownPromise = (async () => {
      await closeServer();
      await lock.release().catch(() => undefined);
    })();
    return shutdownPromise;
  };

  requestShutdown = () => {
    void shutdown();
  };
  if (lockCompromised) {
    requestShutdown();
  }

  const signalHandler = (): void => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);

  try {
    await listen(server, options.configuredPort);
    listening = true;

    const access: OAuthBrokerAccessDescriptor = parseOAuthBrokerAccessDescriptor({
      format: OAUTH_BROKER_ACCESS_FORMAT,
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      namespaceId: options.namespaceId,
      instanceId,
      port: options.configuredPort,
      startedAt,
      secret,
    });
    await writeOAuthBrokerAccess(options.rootDir, access);

    idleTimer = setInterval(evaluateIdle, Math.max(100, Math.floor(options.presenceTtlMs / 3)));
    idleTimer.unref?.();
    evaluateIdle();
  } catch (error) {
    await shutdown();
    process.off("SIGTERM", signalHandler);
    process.off("SIGINT", signalHandler);
    if (isErrorWithCode(error) && error.code === "EADDRINUSE") {
      throw new BrokerStartupError(
        "port-unavailable",
        `OAuth broker could not bind configured port ${options.configuredPort}.`,
        17,
      );
    }
    throw error;
  }

  try {
    await new Promise<void>(resolveExit => {
      server.once("close", resolveExit);
    });
    await shutdown();
  } finally {
    process.off("SIGTERM", signalHandler);
    process.off("SIGINT", signalHandler);
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = getRequestId(request);
    const pathname = getPathname(request);

    if (pathname === OAUTH_BROKER_ROUTES.callback && request.method === "GET") {
      sendCallbackUnavailable(response);
      return;
    }

    if (!isAuthorized(request, secret)) {
      sendError(response, requestId, 401, "unauthorized", "OAuth broker authentication failed.");
      return;
    }

    let requestPresence: OAuthBrokerPresenceIdentity | undefined;
    try {
      requestPresence = pathname === OAUTH_BROKER_ROUTES.presence
        ? undefined
        : readOptionalPresenceIdentity(request);
    } catch (error) {
      sendError(
        response,
        requestId,
        400,
        "invalid-presence",
        error instanceof Error ? error.message : "OAuth broker presence headers are invalid.",
      );
      return;
    }

    const requiresPresence = pathname.startsWith("/v1/")
      && pathname !== OAUTH_BROKER_ROUTES.health
      && pathname !== OAUTH_BROKER_ROUTES.presence;
    if (requiresPresence && !requestPresence) {
      sendError(
        response,
        requestId,
        400,
        "presence-required",
        "OAuth broker session and presence headers are required.",
      );
      return;
    }

    // Liveness is transport-level: receiving any authenticated request from the
    // current incarnation proves the session is alive, independent of its domain result.
    // A successful response renews it again so long-running RPCs align the broker
    // expiry deadline with the client's post-response heartbeat deadline.
    if (requestPresence) {
      const result = renewPresence(requestPresence);
      if (!result.ok) {
        sendError(response, requestId, 409, result.code, result.message);
        evaluateIdle();
        return;
      }
      const responsePresence = requestPresence;
      response.once("finish", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          renewPresence(responsePresence);
        }
        evaluateIdle();
      });
    }

    if (pathname === OAUTH_BROKER_ROUTES.health && request.method === "GET") {
      sendSuccess(response, requestId, currentHealth());
      return;
    }

    if (pathname === OAUTH_BROKER_ROUTES.presence && request.method === "POST") {
      pendingOperationCount += 1;
      try {
        const params = await parseRequestParams(
          request,
          requestId,
          parseOAuthBrokerPresenceRequest,
          response,
        );
        if (!params) {
          return;
        }
        const result = applyPresence(params);
        if (!result.ok) {
          sendError(response, requestId, 409, result.code, result.message);
          return;
        }
        sendSuccess(response, requestId, currentHealth());
      } finally {
        pendingOperationCount -= 1;
        evaluateIdle();
      }
      return;
    }

    const isOAuthRoute = pathname === OAUTH_BROKER_ROUTES.oauthStatus
      || pathname === OAUTH_BROKER_ROUTES.oauthToken
      || pathname === OAUTH_BROKER_ROUTES.oauthLogout;
    if (!isOAuthRoute || request.method !== "POST") {
      sendError(response, requestId, 404, "route-not-found", "OAuth broker route was not found.");
      return;
    }

    pendingOperationCount += 1;
    try {
      if (pathname === OAUTH_BROKER_ROUTES.oauthStatus) {
        const params = await parseRequestParams(
          request,
          requestId,
          parseOAuthBrokerIdentityRequest,
          response,
        );
        if (!params || !validateIdentityNamespace(
          params,
          options.namespaceId,
          requestId,
          response,
        )) {
          return;
        }
        const credential = await tokenCoordinator.getCredentialView(params.identity);
        sendSuccess(response, requestId, {
          oauthState: credentialIsAuthorized(credential, params.scope, options.now?.() ?? Date.now())
            ? "authorized"
            : "authorization-required",
          credentialRevision: credential.credentialRevision,
        });
        return;
      }

      if (pathname === OAUTH_BROKER_ROUTES.oauthToken) {
        const params = await parseRequestParams(
          request,
          requestId,
          parseOAuthBrokerTokenRequest,
          response,
        );
        if (!params || !validateIdentityNamespace(
          params,
          options.namespaceId,
          requestId,
          response,
        )) {
          return;
        }
        try {
          const token = await tokenCoordinator.getAccessToken(params.identity, {
            minRemainingMs: params.minRemainingMs,
            rejectedCredentialRevision: params.rejectedCredentialRevision,
            scope: params.scope,
          });
          sendSuccess(response, requestId, token);
        } catch (error) {
          sendOAuthOperationError(response, requestId, error);
        }
        return;
      }

      const params = await parseRequestParams(
        request,
        requestId,
        parseOAuthBrokerLogoutRequest,
        response,
      );
      if (!params || !validateIdentityNamespace(
        params,
        options.namespaceId,
        requestId,
        response,
      )) {
        return;
      }
      const result = await tokenCoordinator.logout(
        params.identity,
        params.expectedCredentialRevision,
      );
      sendSuccess(response, requestId, {
        applied: result.applied,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        oauthState: credentialIsAuthorized(
          result.credential,
          params.scope,
          options.now?.() ?? Date.now(),
        ) ? "authorized" : "authorization-required",
        credentialRevision: result.credential.credentialRevision,
      });
    } finally {
      pendingOperationCount -= 1;
      evaluateIdle();
    }
  }

  function renewPresence(
    request: OAuthBrokerPresenceIdentity,
  ): { ok: true } | { ok: false; code: string; message: string } {
    const current = sessions.get(request.sessionId);
    if (!current || current.presenceId !== request.presenceId) {
      return {
        ok: false,
        code: "presence-not-found",
        message: "OAuth broker presence incarnation is no longer registered.",
      };
    }
    current.expiresAt = Date.now() + options.presenceTtlMs;
    clearIdleDeadline();
    return { ok: true };
  }

  function applyPresence(
    request: OAuthBrokerPresenceRequest,
  ): { ok: true } | { ok: false; code: string; message: string } {
    if (request.action === "register") {
      sessions.set(request.sessionId, {
        presenceId: request.presenceId,
        expiresAt: Date.now() + options.presenceTtlMs,
      });
      clearIdleDeadline();
      return { ok: true };
    }

    if (request.action === "pulse") {
      return renewPresence(request);
    }

    const current = sessions.get(request.sessionId);
    if (!current || current.presenceId !== request.presenceId) {
      return {
        ok: false,
        code: "presence-not-found",
        message: "OAuth broker presence incarnation is no longer registered.",
      };
    }
    sessions.delete(request.sessionId);
    return { ok: true };
  }
}

async function parseRequestParams<T>(
  request: IncomingMessage,
  requestId: string,
  parser: (value: unknown) => T,
  response: ServerResponse,
): Promise<T | undefined> {
  try {
    const envelope = parseOAuthBrokerRequestEnvelope(await readJsonBody(request), parser);
    if (envelope.requestId !== requestId) {
      throw new TypeError("requestId header and body do not match.");
    }
    return envelope.params;
  } catch (error) {
    sendError(
      response,
      requestId,
      400,
      "invalid-request",
      error instanceof Error ? error.message : "OAuth broker request is invalid.",
    );
    return undefined;
  }
}

function validateIdentityNamespace(
  params: OAuthBrokerIdentityRequest | OAuthBrokerTokenRequest | OAuthBrokerLogoutRequest,
  namespaceId: string,
  requestId: string,
  response: ServerResponse,
): boolean {
  if (params.identity.namespaceId === namespaceId) {
    return true;
  }
  sendError(
    response,
    requestId,
    400,
    "identity-namespace-mismatch",
    "OAuth identity namespace does not match this broker.",
  );
  return false;
}

function credentialIsAuthorized(
  credential: {
    readonly hasAccessToken: boolean;
    readonly accessTokenExpiresAt?: number;
    readonly hasRefreshToken: boolean;
    readonly scope?: string;
  },
  requestedScope: string | undefined,
  now: number,
): boolean {
  const scopeSatisfied = requestedScope === undefined
    || (credential.scope !== undefined && requestedScope.split(" ").every(
      value => credential.scope?.split(" ").includes(value) === true,
    ));
  if (!scopeSatisfied) {
    return false;
  }
  return credential.hasRefreshToken
    || (credential.hasAccessToken && (credential.accessTokenExpiresAt ?? 0) > now);
}

function sendOAuthOperationError(
  response: ServerResponse,
  requestId: string,
  error: unknown,
): void {
  if (error instanceof OAuthAuthorizationRequiredError
    || error instanceof OAuthCredentialChangedError
    || error instanceof OAuthScopeNotGrantedError) {
    sendError(response, requestId, 409, error.code, error.message);
    return;
  }
  if (error instanceof OAuthTemporaryProtocolError) {
    sendError(response, requestId, 503, error.code, error.message);
    return;
  }
  sendError(
    response,
    requestId,
    500,
    "credential-operation-failed",
    "OAuth broker credential operation failed.",
  );
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function getPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function getRequestId(request: IncomingMessage): string {
  const value = request.headers[OAUTH_BROKER_REQUEST_ID_HEADER];
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : `anonymous-${randomUUID()}`;
}

function readOptionalPresenceIdentity(
  request: IncomingMessage,
): OAuthBrokerPresenceIdentity | undefined {
  const sessionId = request.headers[OAUTH_BROKER_SESSION_ID_HEADER];
  const presenceId = request.headers[OAUTH_BROKER_PRESENCE_ID_HEADER];
  if (sessionId === undefined && presenceId === undefined) {
    return undefined;
  }
  if (typeof sessionId !== "string" || typeof presenceId !== "string") {
    throw new TypeError("OAuth broker session and presence headers must be provided together.");
  }
  return parseOAuthBrokerPresenceIdentity({ sessionId, presenceId });
}

function isAuthorized(request: IncomingMessage, secret: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  return oauthBrokerSecretsEqual(authorization.slice("Bearer ".length), secret);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new TypeError("OAuth broker request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new TypeError("OAuth broker request body is required.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("OAuth broker request body must be valid JSON.");
  }
}

function sendSuccess<T>(response: ServerResponse, requestId: string, result: T): void {
  sendJson(response, 200, createOAuthBrokerSuccessEnvelope(requestId, result));
}

function sendError(
  response: ServerResponse,
  requestId: string,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, createOAuthBrokerErrorEnvelope(requestId, code, message));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function sendCallbackUnavailable(response: ServerResponse): void {
  const body = "OAuth authorization transaction was not found.";
  response.writeHead(400, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function parsePositiveInteger(value: string | undefined, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BrokerStartupError("invalid-arguments", `${fieldName} must be a positive integer.`, 2);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new BrokerStartupError("invalid-arguments", "OAuth broker arguments must be --key value pairs.", 2);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runOAuthBrokerProcess({
    rootDir: args.root ?? "",
    namespaceId: args.namespace ?? "",
    configuredPort: parsePositiveInteger(args.port, "port"),
    presenceTtlMs: parsePositiveInteger(args["presence-ttl-ms"], "presence-ttl-ms"),
    idleGraceMs: parsePositiveInteger(args["idle-grace-ms"], "idle-grace-ms"),
    lockStaleMs: args["lock-stale-ms"] === undefined
      ? undefined
      : parsePositiveInteger(args["lock-stale-ms"], "lock-stale-ms"),
    lockUpdateMs: args["lock-update-ms"] === undefined
      ? undefined
      : parsePositiveInteger(args["lock-update-ms"], "lock-update-ms"),
  });
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    const code = error instanceof BrokerStartupError
      ? error.code
      : error instanceof OAuthBrokerLockError
        ? error.code
        : "broker-start-failed";
    const exitCode = error instanceof BrokerStartupError
      ? error.exitCode
      : error instanceof OAuthBrokerLockError && error.code === "lock-unavailable"
        ? 17
        : 18;
    process.stderr.write(`${JSON.stringify({
      code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = exitCode;
  });
}
