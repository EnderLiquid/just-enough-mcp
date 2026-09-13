import { randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeOAuthScope } from "./credential-state.ts";
import { parseOAuthIdentity, type OAuthIdentity } from "./identity.ts";
import type { OAuthLogoutRefusalReason } from "./token-coordinator.ts";

export const OAUTH_BROKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_OAUTH_BROKER_PORT = 33_418;
export const DEFAULT_OAUTH_BROKER_REQUEST_TIMEOUT_MS = 2_000;
export const DEFAULT_OAUTH_BROKER_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_OAUTH_BROKER_RECONNECT_INTERVAL_MS = 1_000;
export const DEFAULT_OAUTH_BROKER_PRESENCE_PULSE_MS = 10_000;
export const DEFAULT_OAUTH_BROKER_PRESENCE_TTL_MS = 30_000;
export const DEFAULT_OAUTH_BROKER_IDLE_GRACE_MS = 5_000;
export const DEFAULT_OAUTH_BROKER_LOCK_STALE_MS = 30_000;
export const DEFAULT_OAUTH_BROKER_LOCK_UPDATE_MS = 10_000;
export const DEFAULT_OAUTH_BROKER_AUTHORIZE_TIMEOUT_MS = 300_000;
export const DEFAULT_OAUTH_BROKER_AUTHORIZE_CALLER_MARGIN_MS = 15_000;

export const OAUTH_BROKER_ACCESS_FORMAT = "just-enough-mcp.oauth-broker-access" as const;
export const OAUTH_BROKER_REQUEST_ID_HEADER = "x-just-enough-mcp-request-id";
export const OAUTH_BROKER_SESSION_ID_HEADER = "x-just-enough-mcp-session-id";
export const OAUTH_BROKER_PRESENCE_ID_HEADER = "x-just-enough-mcp-presence-id";

export const OAUTH_BROKER_ROUTES = {
  callback: "/oauth/callback",
  health: "/v1/health",
  presence: "/v1/presence",
  oauthStatus: "/v1/oauth/status",
  oauthToken: "/v1/oauth/token",
  oauthLogout: "/v1/oauth/logout",
  oauthAuthorize: "/v1/oauth/authorize",
} as const;

export type OAuthBrokerPresenceAction = "register" | "pulse" | "release";

/** 固定路径的 access snapshot。文件可以陈旧，只有认证 health 才证明 broker 可用。 */
export interface OAuthBrokerAccessDescriptor {
  readonly format: typeof OAUTH_BROKER_ACCESS_FORMAT;
  readonly protocolVersion: typeof OAUTH_BROKER_PROTOCOL_VERSION;
  readonly namespaceId: string;
  readonly instanceId: string;
  readonly port: number;
  readonly startedAt: number;
  readonly secret: string;
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

export interface OAuthBrokerPresenceIdentity {
  readonly sessionId: string;
  readonly presenceId: string;
}

export interface OAuthBrokerPresenceRequest extends OAuthBrokerPresenceIdentity {
  readonly action: OAuthBrokerPresenceAction;
}

export type OAuthBrokerKnownState =
  | "authorization-required"
  | "authorizing"
  | "authorized";

export interface OAuthBrokerIdentityRequest {
  readonly identity: OAuthIdentity;
  readonly scope?: string;
}

export interface OAuthBrokerTokenRequest extends OAuthBrokerIdentityRequest {
  /** 省略时为 0；broker 仍会 reserve 自己的 safety window。 */
  readonly minRemainingMs?: number;
  readonly rejectedCredentialRevision?: number;
}

export interface OAuthBrokerLogoutRequest extends OAuthBrokerIdentityRequest {
  readonly expectedCredentialRevision?: number;
}

export interface OAuthBrokerAuthorizeRequest extends OAuthBrokerIdentityRequest {
  /** session 观察到的初始 401 challenge `scope`，作为 base 候选。 */
  readonly initialChallengeScope?: string;
  /** 同一 401 challenge 的 PRM URL，作为 live discovery 的首选路径。 */
  readonly resourceMetadataUrl?: string;
}

export interface OAuthBrokerStatusResult {
  readonly oauthState: OAuthBrokerKnownState;
  readonly credentialRevision: number;
}

export interface OAuthBrokerTokenResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly credentialRevision: number;
}

export interface OAuthBrokerLogoutResult extends OAuthBrokerStatusResult {
  readonly applied: boolean;
  /** 仅当 applied 为 false 时给出，用于区分 revision 已被取代和 refresh 在途。 */
  readonly reason?: OAuthLogoutRefusalReason;
}

export interface OAuthBrokerAuthorizeResult {
  readonly oauthState: "authorized";
  readonly credentialRevision: number;
  /** token response 返回的 granted scope；AS 省略时为本次请求的 final scope。 */
  readonly scope?: string;
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

const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createOAuthBrokerSecret(): string {
  return randomBytes(32).toString("hex");
}

export function oauthBrokerSecretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function getOAuthBrokerOrigin(port: number): string {
  return `http://127.0.0.1:${assertOAuthBrokerPort(port, "port")}`;
}

export function getOAuthBrokerUrl(port: number, pathname: string): string {
  if (!pathname.startsWith("/")) {
    throw new TypeError("OAuth broker pathname must begin with '/'.");
  }
  return `${getOAuthBrokerOrigin(port)}${pathname}`;
}

export function createOAuthBrokerRequestEnvelope<T>(
  requestId: string,
  params: T,
): OAuthBrokerRequestEnvelope<T> {
  assertOAuthBrokerRequestId(requestId);
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
  assertOAuthBrokerRequestId(requestId);
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
  assertOAuthBrokerRequestId(requestId);
  assertNonEmptyString(code, "error.code");
  assertNonEmptyString(message, "error.message");
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
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
    instanceId: assertOAuthBrokerId(record.instanceId, "access.instanceId"),
    port: assertOAuthBrokerPort(record.port, "access.port"),
    startedAt: assertNonNegativeFinite(record.startedAt, "access.startedAt"),
    secret: assertPattern(record.secret, SECRET_PATTERN, "access.secret"),
  };
}

export function parseOAuthBrokerHealth(value: unknown): OAuthBrokerHealth {
  const record = requireRecord(value, "OAuth broker health result");
  return {
    namespaceId: assertNonEmptyString(record.namespaceId, "health.namespaceId"),
    instanceId: assertOAuthBrokerId(record.instanceId, "health.instanceId"),
    pid: assertPositiveSafeInteger(record.pid, "health.pid"),
    port: assertOAuthBrokerPort(record.port, "health.port"),
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

export function parseOAuthBrokerPresenceIdentity(value: unknown): OAuthBrokerPresenceIdentity {
  const record = requireRecord(value, "OAuth broker presence identity");
  return {
    sessionId: assertOAuthBrokerRequestId(record.sessionId, "presence.sessionId"),
    presenceId: assertOAuthBrokerId(record.presenceId, "presence.presenceId"),
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
    ...parseOAuthBrokerPresenceIdentity(record),
  };
}

export function parseOAuthBrokerIdentityRequest(value: unknown): OAuthBrokerIdentityRequest {
  const record = requireRecord(value, "OAuth broker identity request");
  return {
    identity: parseOAuthIdentity(record.identity),
    ...(record.scope === undefined
      ? {}
      : { scope: normalizeOAuthScope(assertString(record.scope, "oauth.scope")) }),
  };
}

export function parseOAuthBrokerTokenRequest(value: unknown): OAuthBrokerTokenRequest {
  const record = requireRecord(value, "OAuth broker token request");
  return {
    ...parseOAuthBrokerIdentityRequest(record),
    minRemainingMs: record.minRemainingMs === undefined
      ? 0
      : assertNonNegativeFinite(record.minRemainingMs, "oauth.minRemainingMs"),
    ...(record.rejectedCredentialRevision === undefined
      ? {}
      : {
          rejectedCredentialRevision: assertNonNegativeSafeInteger(
            record.rejectedCredentialRevision,
            "oauth.rejectedCredentialRevision",
          ),
        }),
  };
}

export function parseOAuthBrokerLogoutRequest(value: unknown): OAuthBrokerLogoutRequest {
  const record = requireRecord(value, "OAuth broker logout request");
  return {
    ...parseOAuthBrokerIdentityRequest(record),
    ...(record.expectedCredentialRevision === undefined
      ? {}
      : {
          expectedCredentialRevision: assertNonNegativeSafeInteger(
            record.expectedCredentialRevision,
            "oauth.expectedCredentialRevision",
          ),
        }),
  };
}

export function parseOAuthBrokerAuthorizeRequest(value: unknown): OAuthBrokerAuthorizeRequest {
  const record = requireRecord(value, "OAuth broker authorize request");
  return {
    ...parseOAuthBrokerIdentityRequest(record),
    ...(record.initialChallengeScope === undefined
      ? {}
      : {
          initialChallengeScope: normalizeOAuthScope(
            assertString(record.initialChallengeScope, "oauth.initialChallengeScope"),
          ),
        }),
    ...(record.resourceMetadataUrl === undefined
      ? {}
      : {
          resourceMetadataUrl: assertAbsoluteHttpUrl(
            record.resourceMetadataUrl,
            "oauth.resourceMetadataUrl",
          ),
        }),
  };
}

export function parseOAuthBrokerStatusResult(value: unknown): OAuthBrokerStatusResult {
  const record = requireRecord(value, "OAuth broker status result");
  return {
    oauthState: parseKnownState(record.oauthState),
    credentialRevision: assertNonNegativeSafeInteger(
      record.credentialRevision,
      "oauth.credentialRevision",
    ),
  };
}

export function parseOAuthBrokerTokenResult(value: unknown): OAuthBrokerTokenResult {
  const record = requireRecord(value, "OAuth broker token result");
  return {
    accessToken: assertNonEmptyString(record.accessToken, "oauth.accessToken"),
    accessTokenExpiresAt: assertFinite(record.accessTokenExpiresAt, "oauth.accessTokenExpiresAt"),
    credentialRevision: assertNonNegativeSafeInteger(
      record.credentialRevision,
      "oauth.credentialRevision",
    ),
  };
}

export function parseOAuthBrokerLogoutResult(value: unknown): OAuthBrokerLogoutResult {
  const record = requireRecord(value, "OAuth broker logout result");
  if (typeof record.applied !== "boolean") {
    throw new TypeError("oauth.applied must be a boolean.");
  }
  if (record.applied && record.reason !== undefined) {
    throw new TypeError("oauth.reason must be absent when oauth.applied is true.");
  }
  return {
    ...parseOAuthBrokerStatusResult(record),
    applied: record.applied,
    ...(record.reason === undefined ? {} : { reason: parseLogoutRefusalReason(record.reason) }),
  };
}

export function parseOAuthBrokerAuthorizeResult(value: unknown): OAuthBrokerAuthorizeResult {
  const record = requireRecord(value, "OAuth broker authorize result");
  const status = parseOAuthBrokerStatusResult(record);
  if (status.oauthState !== "authorized") {
    throw new TypeError("oauth.oauthState must be authorized for a successful authorize result.");
  }
  return {
    oauthState: "authorized",
    credentialRevision: status.credentialRevision,
    ...(record.scope === undefined
      ? {}
      : { scope: normalizeOAuthScope(assertString(record.scope, "oauth.scope")) }),
  };
}

function parseLogoutRefusalReason(value: unknown): OAuthLogoutRefusalReason {
  if (value !== "revision-superseded" && value !== "refresh-in-flight") {
    throw new TypeError("oauth.reason is invalid.");
  }
  return value;
}

export function parseOAuthBrokerRequestEnvelope<T>(
  value: unknown,
  parseParams: (params: unknown) => T,
): OAuthBrokerRequestEnvelope<T> {
  const record = requireRecord(value, "OAuth broker request");
  assertProtocolVersion(record.protocolVersion, "request.protocolVersion");
  return {
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    requestId: assertOAuthBrokerRequestId(record.requestId),
    params: parseParams(record.params),
  };
}

export function parseOAuthBrokerResponseEnvelope(
  value: unknown,
  expectedRequestId: string,
): OAuthBrokerSuccessEnvelope<unknown> | OAuthBrokerErrorEnvelope {
  const record = requireRecord(value, "OAuth broker response");
  assertProtocolVersion(record.protocolVersion, "response.protocolVersion");
  const requestId = assertOAuthBrokerRequestId(record.requestId, "response.requestId");
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
  return assertPattern(value, UUID_PATTERN, fieldName);
}

export function assertOAuthBrokerRequestId(
  value: unknown,
  fieldName = "requestId",
): string {
  return assertPattern(value, REQUEST_ID_PATTERN, fieldName);
}

export function assertOAuthBrokerPort(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new TypeError(`${fieldName} must be an integer from 1 to 65535.`);
  }
  return value as number;
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

function assertAbsoluteHttpUrl(value: unknown, fieldName: string): string {
  const raw = assertNonEmptyString(value, fieldName);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${fieldName} must be an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${fieldName} must use http or https.`);
  }
  return url.toString();
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

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string.`);
  }
  return value;
}

function parseKnownState(value: unknown): OAuthBrokerKnownState {
  if (value !== "authorization-required" && value !== "authorizing" && value !== "authorized") {
    throw new TypeError("oauth.oauthState is invalid.");
  }
  return value;
}

function assertPattern(value: unknown, pattern: RegExp, fieldName: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${fieldName} has an invalid format.`);
  }
  return value;
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

function assertFinite(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number.`);
  }
  return value;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
