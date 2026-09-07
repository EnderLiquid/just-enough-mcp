import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOAuthBrokerErrorEnvelope,
  createOAuthBrokerSecret,
  createOAuthBrokerSuccessEnvelope,
  digestOAuthBrokerSecret,
  isProcessAlive,
  oauthBrokerSecretsEqual,
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_CLAIM_TOKEN_ENV,
  OAUTH_BROKER_ENDPOINT_FORMAT,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_REQUEST_ID_HEADER,
  OAUTH_BROKER_ROUTES,
  parseOAuthBrokerPresenceRequest,
  parseOAuthBrokerRequestEnvelope,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerEndpointDescriptor,
  type OAuthBrokerHealth,
} from "./protocol.ts";
import {
  ensureOAuthBrokerRuntimeIdentity,
  readOAuthBrokerClaim,
  listOAuthBrokerClaims,
  listOAuthBrokerPublications,
  removeOAuthBrokerCandidate,
  writeOAuthBrokerPublication,
} from "./runtime-files.ts";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface BrokerProcessOptions {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly claimId: string;
  readonly requestedPort: number;
  readonly presenceTtlMs: number;
  readonly idleGraceMs: number;
  readonly claimToken: string;
}

interface PresenceRecord {
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

export async function runOAuthBrokerProcess(options: BrokerProcessOptions): Promise<void> {
  await ensureOAuthBrokerRuntimeIdentity(options.rootDir, options.namespaceId);
  const claim = await readOAuthBrokerClaim(options.rootDir, options.claimId);
  if (!claim
    || claim.namespaceId !== options.namespaceId
    || claim.requestedPort !== options.requestedPort
    || claim.expiresAt <= Date.now()
    || !oauthBrokerSecretsEqual(
      claim.claimTokenDigest,
      digestOAuthBrokerSecret(options.claimToken),
    )) {
    throw new BrokerStartupError("broker-claim-rejected", "OAuth broker owner claim is invalid or expired.", 16);
  }

  const instanceId = randomUUID();
  const secret = createOAuthBrokerSecret();
  const startedAt = Date.now();
  const sessions = new Map<string, PresenceRecord>();
  let idleDeadline: number | undefined;
  let pendingOperationCount = 0;
  let listening = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const currentHealth = (): OAuthBrokerHealth => ({
    namespaceId: options.namespaceId,
    instanceId,
    pid: process.pid,
    port: options.requestedPort,
    startedAt,
    presenceCount: sessions.size,
    pendingOperationCount,
    idleDeadline: idleDeadline ?? null,
  });

  const clearIdleDeadline = () => {
    idleDeadline = undefined;
  };

  const expirePresence = () => {
    const now = Date.now();
    for (const [sessionId, presence] of sessions) {
      if (presence.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }
  };

  const evaluateIdle = () => {
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

  const server = createServer(async (request, response) => {
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

    if (pathname === OAUTH_BROKER_ROUTES.health && request.method === "GET") {
      sendSuccess(response, requestId, currentHealth());
      return;
    }

    if (pathname === OAUTH_BROKER_ROUTES.presence && request.method === "POST") {
      let envelope;
      try {
        envelope = parseOAuthBrokerRequestEnvelope(
          await readJsonBody(request),
          parseOAuthBrokerPresenceRequest,
        );
        if (envelope.requestId !== requestId) {
          throw new TypeError("requestId header and body do not match.");
        }
      } catch (error) {
        sendError(
          response,
          requestId,
          400,
          "invalid-request",
          error instanceof Error ? error.message : "OAuth broker request is invalid.",
        );
        return;
      }

      const { action, sessionId } = envelope.params;
      if (action === "register") {
        sessions.set(sessionId, { expiresAt: Date.now() + options.presenceTtlMs });
        clearIdleDeadline();
      } else if (action === "pulse") {
        if (!sessions.has(sessionId)) {
          sendError(response, requestId, 409, "presence-not-found", "OAuth broker presence is no longer registered.");
          evaluateIdle();
          return;
        }
        sessions.set(sessionId, { expiresAt: Date.now() + options.presenceTtlMs });
        clearIdleDeadline();
      } else {
        sessions.delete(sessionId);
      }

      sendSuccess(response, requestId, currentHealth());
      evaluateIdle();
      return;
    }

    sendError(response, requestId, 404, "route-not-found", "OAuth broker route was not found.");
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
    shutdownPromise = (async () => {
      await closeServer();
      await removeOAuthBrokerCandidate(options.rootDir, options.claimId).catch(() => undefined);
    })();
    return shutdownPromise;
  };

  const signalHandler = () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);

  try {
    await assertNoCompetingPublication(options.namespaceId, options.rootDir, options.claimId);
    await assertElectionWinner(options.namespaceId, options.rootDir, options.claimId);
    await listen(server, options.requestedPort);
    listening = true;
    await assertNoCompetingPublication(options.namespaceId, options.rootDir, options.claimId);
    await assertElectionWinner(options.namespaceId, options.rootDir, options.claimId);

    const endpoint: OAuthBrokerEndpointDescriptor = {
      format: OAUTH_BROKER_ENDPOINT_FORMAT,
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      namespaceId: options.namespaceId,
      claimId: options.claimId,
      instanceId,
      pid: process.pid,
      port: options.requestedPort,
      startedAt,
    };
    const access: OAuthBrokerAccessDescriptor = {
      format: OAUTH_BROKER_ACCESS_FORMAT,
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      namespaceId: options.namespaceId,
      claimId: options.claimId,
      instanceId,
      secret,
    };
    await writeOAuthBrokerPublication(options.rootDir, { endpoint, access });
    evaluateIdle();
  } catch (error) {
    await shutdown();
    if (isErrorWithCode(error) && error.code === "EADDRINUSE") {
      throw new BrokerStartupError("port-unavailable", "The configured OAuth broker port is already in use.", 17);
    }
    throw error;
  }

  const idleTimer = setInterval(
    evaluateIdle,
    Math.max(100, Math.min(1_000, Math.floor(options.presenceTtlMs / 3))),
  );
  idleTimer.unref?.();

  await new Promise<void>(resolveExit => {
    server.once("close", resolveExit);
  });
  clearInterval(idleTimer);
  await shutdown();
}

async function assertNoCompetingPublication(
  namespaceId: string,
  rootDir: string,
  claimId: string,
): Promise<void> {
  const competing = (await listOAuthBrokerPublications(rootDir)).find(publication =>
    publication.endpoint.namespaceId === namespaceId
    && publication.endpoint.claimId !== claimId
    && isProcessAlive(publication.endpoint.pid));
  if (competing) {
    throw new BrokerStartupError(
      "claim-lost",
      "Another OAuth broker owner published first.",
      20,
    );
  }
}

async function assertElectionWinner(
  namespaceId: string,
  rootDir: string,
  claimId: string,
): Promise<void> {
  const now = Date.now();
  const claims = (await listOAuthBrokerClaims(rootDir))
    .filter(candidate => candidate.namespaceId === namespaceId && candidate.expiresAt > now)
    .sort((left, right) =>
      left.createdAt - right.createdAt || left.claimId.localeCompare(right.claimId));
  if (claims[0]?.claimId !== claimId) {
    throw new BrokerStartupError(
      "claim-lost",
      "OAuth broker owner claim lost the startup election.",
      20,
    );
  }
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
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
  const claimToken = process.env[OAUTH_BROKER_CLAIM_TOKEN_ENV];
  delete process.env[OAUTH_BROKER_CLAIM_TOKEN_ENV];
  if (!claimToken) {
    throw new BrokerStartupError("invalid-arguments", "OAuth broker claim token is missing.", 2);
  }

  await runOAuthBrokerProcess({
    rootDir: args.root ?? "",
    namespaceId: args.namespace ?? "",
    claimId: args.claim ?? "",
    requestedPort: parsePositiveInteger(args.port, "port"),
    presenceTtlMs: parsePositiveInteger(args["presence-ttl-ms"], "presence-ttl-ms"),
    idleGraceMs: parsePositiveInteger(args["idle-grace-ms"], "idle-grace-ms"),
    claimToken,
  });
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    const code = error instanceof BrokerStartupError ? error.code : "broker-start-failed";
    const exitCode = error instanceof BrokerStartupError ? error.exitCode : 18;
    process.stderr.write(`${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = exitCode;
  });
}
