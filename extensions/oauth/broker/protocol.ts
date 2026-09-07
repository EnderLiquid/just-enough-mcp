import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_BROKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_OAUTH_BROKER_PORT = 33418;
export const DEFAULT_OAUTH_BROKER_STARTUP_TIMEOUT_MS = 5_000;
export const DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS = 2_000;
export const DEFAULT_OAUTH_BROKER_ELECTION_WINDOW_MS = 75;
export const DEFAULT_OAUTH_BROKER_CLAIM_TTL_MS = 10_000;
export const DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS = 10_000;
export const DEFAULT_OAUTH_BROKER_PRESENCE_TTL_MS = 30_000;
export const DEFAULT_OAUTH_BROKER_IDLE_GRACE_MS = 5_000;

export const OAUTH_BROKER_RUNTIME_FORMAT = "just-enough-mcp.oauth-broker-runtime" as const;
export const OAUTH_BROKER_CLAIM_FORMAT = "just-enough-mcp.oauth-broker-claim" as const;
export const OAUTH_BROKER_ENDPOINT_FORMAT = "just-enough-mcp.oauth-broker-endpoint" as const;
export const OAUTH_BROKER_ACCESS_FORMAT = "just-enough-mcp.oauth-broker-access" as const;
export const OAUTH_BROKER_CLAIM_TOKEN_ENV = "JUST_ENOUGH_MCP_OAUTH_BROKER_CLAIM_TOKEN";
export const OAUTH_BROKER_REQUEST_ID_HEADER = "x-just-enough-mcp-request-id";

export const OAUTH_BROKER_ROUTES = {
  callback: "/oauth/callback",
  health: "/v1/health",
  presence: "/v1/presence",
} as const;

export type OAuthBrokerPresenceAction = "register" | "pulse" | "release";

export interface OAuthBrokerRuntimeIdentity {
  readonly format: typeof OAUTH_BROKER_RUNTIME_FORMAT;
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly namespaceId: string;
}

export interface OAuthBrokerOwnerClaim {
  readonly format: typeof OAUTH_BROKER_CLAIM_FORMAT;
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly namespaceId: string;
  readonly claimId: string;
  readonly claimTokenDigest: string;
  readonly claimantPid: number;
  readonly requestedPort: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * 可公开发现的 endpoint 描述。认证 secret 和 owner token 不得写入这里。
 */
export interface OAuthBrokerEndpointDescriptor {
  readonly format: typeof OAUTH_BROKER_ENDPOINT_FORMAT;
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly namespaceId: string;
  readonly claimId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
}

/** 与 endpoint 分文件保存、仅供同一 agentDir 下可信 session 读取的控制面凭据。 */
export interface OAuthBrokerAccessDescriptor {
  readonly format: typeof OAUTH_BROKER_ACCESS_FORMAT;
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly namespaceId: string;
  readonly claimId: string;
  readonly instanceId: string;
  readonly secret: string;
}

export interface OAuthBrokerPublication {
  readonly endpoint: OAuthBrokerEndpointDescriptor;
  readonly access: OAuthBrokerAccessDescriptor;
}

export interface OAuthBrokerHealth {
  readonly namespaceId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
  readonly presenceCount: number;
  readonly pendingOperationCount: number;
  readonly idleDeadline: number | null;
}

export interface OAuthBrokerPresenceRequest {
  readonly action: OAuthBrokerPresenceAction;
  readonly sessionId: string;
}

export interface OAuthBrokerRequestEnvelope<T> {
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly params: T;
}

export interface OAuthBrokerSuccessEnvelope<T> {
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly result: T;
}

export interface OAuthBrokerErrorBody {
  readonly code: string;
  readonly message: string;
}

export interface OAuthBrokerErrorEnvelope {
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: false;
  readonly error: OAuthBrokerErrorBody;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createOAuthBrokerSecret(): string {
  return randomBytes(32).toString("hex");
}

export function digestOAuthBrokerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function oauthBrokerSecretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function getOAuthBrokerOrigin(endpoint: OAuthBrokerEndpointDescriptor): string {
  return `http://127.0.0.1:${endpoint.port}`;
}

export function getOAuthBrokerUrl(
  endpoint: OAuthBrokerEndpointDescriptor,
  pathname: string,
): string {
  if (!pathname.startsWith("/")) {
    throw new TypeError("OAuth broker pathname must begin with '/'.");
  }
  return `${getOAuthBrokerOrigin(endpoint)}${pathname}`;
}

export function createOAuthBrokerRequestEnvelope<T>(
  requestId: string,
  params: T,
): OAuthBrokerRequestEnvelope<T> {
  assertRequestId(requestId);
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId,
    params,
  };
}

export function createOAuthBrokerSuccessEnvelope<T>(
  requestId: string,
  result: T,
): OAuthBrokerSuccessEnvelope<T> {
  assertRequestId(requestId);
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
  };
}

export function createOAuthBrokerErrorEnvelope(
  requestId: string,
  code: string,
  message: string,
): OAuthBrokerErrorEnvelope {
  assertRequestId(requestId);
  assertNonEmptyString(code, "error.code");
  assertNonEmptyString(message, "error.message");
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

export function parseOAuthBrokerRuntimeIdentity(
  value: unknown,
): OAuthBrokerRuntimeIdentity {
  const record = requireRecord(value, "OAuth broker runtime identity");
  assertLiteral(record.format, OAUTH_BROKER_RUNTIME_FORMAT, "runtime.format");
  assertProtocolVersion(record.protocolVersion, "runtime.protocolVersion");
  return {
    format: OAUTH_BROKER_RUNTIME_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId: assertNonEmptyString(record.namespaceId, "runtime.namespaceId"),
  };
}

export function parseOAuthBrokerOwnerClaim(value: unknown): OAuthBrokerOwnerClaim {
  const record = requireRecord(value, "OAuth broker claim");
  assertLiteral(record.format, OAUTH_BROKER_CLAIM_FORMAT, "claim.format");
  assertProtocolVersion(record.protocolVersion, "claim.protocolVersion");
  const namespaceId = assertNonEmptyString(record.namespaceId, "claim.namespaceId");
  const claimId = assertUuid(record.claimId, "claim.claimId");
  const claimTokenDigest = assertPattern(record.claimTokenDigest, SHA256_HEX_PATTERN, "claim.claimTokenDigest");
  const claimantPid = assertPositiveSafeInteger(record.claimantPid, "claim.claimantPid");
  const requestedPort = assertPort(record.requestedPort, "claim.requestedPort");
  const createdAt = assertNonNegativeFinite(record.createdAt, "claim.createdAt");
  const expiresAt = assertNonNegativeFinite(record.expiresAt, "claim.expiresAt");
  if (expiresAt <= createdAt) {
    throw new TypeError("claim.expiresAt must be later than claim.createdAt.");
  }
  return {
    format: OAUTH_BROKER_CLAIM_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId,
    claimId,
    claimTokenDigest,
    claimantPid,
    requestedPort,
    createdAt,
    expiresAt,
  };
}

export function parseOAuthBrokerEndpointDescriptor(
  value: unknown,
): OAuthBrokerEndpointDescriptor {
  const record = requireRecord(value, "OAuth broker endpoint");
  assertLiteral(record.format, OAUTH_BROKER_ENDPOINT_FORMAT, "endpoint.format");
  assertProtocolVersion(record.protocolVersion, "endpoint.protocolVersion");
  return {
    format: OAUTH_BROKER_ENDPOINT_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId: assertNonEmptyString(record.namespaceId, "endpoint.namespaceId"),
    claimId: assertUuid(record.claimId, "endpoint.claimId"),
    instanceId: assertUuid(record.instanceId, "endpoint.instanceId"),
    pid: assertPositiveSafeInteger(record.pid, "endpoint.pid"),
    port: assertPort(record.port, "endpoint.port"),
    startedAt: assertNonNegativeFinite(record.startedAt, "endpoint.startedAt"),
  };
}

export function parseOAuthBrokerAccessDescriptor(
  value: unknown,
): OAuthBrokerAccessDescriptor {
  const record = requireRecord(value, "OAuth broker access descriptor");
  assertLiteral(record.format, OAUTH_BROKER_ACCESS_FORMAT, "access.format");
  assertProtocolVersion(record.protocolVersion, "access.protocolVersion");
  return {
    format: OAUTH_BROKER_ACCESS_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId: assertNonEmptyString(record.namespaceId, "access.namespaceId"),
    claimId: assertUuid(record.claimId, "access.claimId"),
    instanceId: assertUuid(record.instanceId, "access.instanceId"),
    secret: assertPattern(record.secret, SECRET_PATTERN, "access.secret"),
  };
}

export function assertOAuthBrokerPublication(
  publication: OAuthBrokerPublication,
): OAuthBrokerPublication {
  const { endpoint, access } = publication;
  if (endpoint.namespaceId !== access.namespaceId
    || endpoint.claimId !== access.claimId
    || endpoint.instanceId !== access.instanceId) {
    throw new TypeError("OAuth broker endpoint and access descriptors do not match.");
  }
  return publication;
}

export function parseOAuthBrokerHealth(value: unknown): OAuthBrokerHealth {
  const record = requireRecord(value, "OAuth broker health result");
  return {
    namespaceId: assertNonEmptyString(record.namespaceId, "health.namespaceId"),
    instanceId: assertUuid(record.instanceId, "health.instanceId"),
    pid: assertPositiveSafeInteger(record.pid, "health.pid"),
    port: assertPort(record.port, "health.port"),
    startedAt: assertNonNegativeFinite(record.startedAt, "health.startedAt"),
    presenceCount: assertNonNegativeSafeInteger(record.presenceCount, "health.presenceCount"),
    pendingOperationCount: assertNonNegativeSafeInteger(
      record.pendingOperationCount,
      "health.pendingOperationCount",
    ),
    idleDeadline: record.idleDeadline === null
      ? null
      : assertNonNegativeFinite(record.idleDeadline, "health.idleDeadline"),
  };
}

export function parseOAuthBrokerPresenceRequest(value: unknown): OAuthBrokerPresenceRequest {
  const record = requireRecord(value, "OAuth broker presence request");
  const action = record.action;
  if (action !== "register" && action !== "pulse" && action !== "release") {
    throw new TypeError("presence.action must be register, pulse, or release.");
  }
  return {
    action,
    sessionId: assertRequestId(record.sessionId, "presence.sessionId"),
  };
}

export function parseOAuthBrokerRequestEnvelope<T>(
  value: unknown,
  parseParams: (params: unknown) => T,
): OAuthBrokerRequestEnvelope<T> {
  const record = requireRecord(value, "OAuth broker request");
  assertProtocolVersion(record.protocolVersion, "request.protocolVersion");
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId: assertRequestId(record.requestId),
    params: parseParams(record.params),
  };
}

export function parseOAuthBrokerResponseEnvelope(
  value: unknown,
  expectedRequestId: string,
): OAuthBrokerSuccessEnvelope<unknown> | OAuthBrokerErrorEnvelope {
  const record = requireRecord(value, "OAuth broker response");
  assertProtocolVersion(record.protocolVersion, "response.protocolVersion");
  const requestId = assertRequestId(record.requestId, "response.requestId");
  if (requestId !== expectedRequestId) {
    throw new TypeError("OAuth broker response requestId does not match the request.");
  }

  if (record.ok === true) {
    return {
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: record.result,
    };
  }
  if (record.ok === false) {
    const error = requireRecord(record.error, "OAuth broker response error");
    return {
      protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: assertNonEmptyString(error.code, "response.error.code"),
        message: assertNonEmptyString(error.message, "response.error.message"),
      },
    };
  }
  throw new TypeError("OAuth broker response.ok must be a boolean.");
}

export function assertOAuthBrokerId(value: unknown, fieldName = "id"): string {
  return assertUuid(value, fieldName);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorWithCode(error) && error.code === "EPERM";
  }
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  fieldName: string,
): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${fieldName} must be ${JSON.stringify(expected)}.`);
  }
}

function assertProtocolVersion(value: unknown, fieldName: string): void {
  if (value !== OAUTH_BROKER_PROTOCOL_VERSION) {
    throw new TypeError(`${fieldName} must be ${OAUTH_BROKER_PROTOCOL_VERSION}.`);
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function assertPattern(value: unknown, pattern: RegExp, fieldName: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${fieldName} has an invalid format.`);
  }
  return value;
}

function assertUuid(value: unknown, fieldName: string): string {
  return assertPattern(value, UUID_PATTERN, fieldName);
}

function assertRequestId(value: unknown, fieldName = "requestId"): string {
  return assertPattern(value, REQUEST_ID_PATTERN, fieldName);
}

function assertPositiveSafeInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer.`);
  }
  return value as number;
}

function assertNonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
  return value as number;
}

function assertNonNegativeFinite(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative finite number.`);
  }
  return value;
}

function assertPort(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new TypeError(`${fieldName} must be an integer from 1 to 65535.`);
  }
  return value as number;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
