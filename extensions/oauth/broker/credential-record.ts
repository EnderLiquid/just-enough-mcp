import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  cloneOAuthCredentialState,
  createOAuthCredentialState,
  type OAuthCredentialState,
} from "./credential-state.ts";

/** DCR（RFC 7591）注册结果；strategy 为后续 CIMD 预留策略标记。 */
export interface OAuthClientRegistration {
  readonly strategy: "dcr";
  readonly authorizationServerUrl: string;
  readonly clientInformation: OAuthClientInformationFull;
}

/** RFC 9728/8414 discovery 快照；fetchedAt 用于 TTL、stale-if-error 与显式刷新。 */
export interface OAuthDiscoveryRecord {
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly resourceMetadata?: OAuthProtectedResourceMetadata;
  readonly fetchedAt: number;
}

/** 单个 identity 在 broker credential document 中的完整记录。 */
export interface OAuthCredentialRecord {
  readonly authorization: OAuthCredentialState;
  /** 尚未完成 DCR 或 client registration 已失效时缺失；存在 token 时必须同时存在。 */
  readonly registration?: OAuthClientRegistration;
  readonly discovery?: OAuthDiscoveryRecord;
  /** 403 `insufficient_scope` 追加的 scope 需求；随 registration 失效一起清空。 */
  readonly challengedScopes: readonly string[];
}

export function createOAuthCredentialRecord(init: {
  authorization?: OAuthCredentialState;
  registration?: OAuthClientRegistration;
  discovery?: OAuthDiscoveryRecord;
  challengedScopes?: readonly string[];
} = {}): OAuthCredentialRecord {
  const record: OAuthCredentialRecord = {
    authorization: init.authorization
      ? cloneOAuthCredentialState(init.authorization)
      : createOAuthCredentialState(),
    challengedScopes: normalizeChallengedScopes(init.challengedScopes ?? []),
    ...(init.registration ? { registration: cloneRegistration(init.registration) } : {}),
    ...(init.discovery ? { discovery: cloneDiscovery(init.discovery) } : {}),
  };
  assertOAuthCredentialRecord(record);
  return record;
}

export function cloneOAuthCredentialRecord(record: OAuthCredentialRecord): OAuthCredentialRecord {
  const cloned: OAuthCredentialRecord = {
    authorization: cloneOAuthCredentialState(record.authorization),
    challengedScopes: [...record.challengedScopes],
    ...(record.registration ? { registration: cloneRegistration(record.registration) } : {}),
    ...(record.discovery ? { discovery: cloneDiscovery(record.discovery) } : {}),
  };
  assertOAuthCredentialRecord(cloned);
  return cloned;
}

function assertOAuthCredentialRecord(record: OAuthCredentialRecord): void {
  if (record.authorization.tokens && !record.registration) {
    throw new TypeError("OAuth token credentials must include a client registration.");
  }
}

export function cloneRegistration(registration: OAuthClientRegistration): OAuthClientRegistration {
  return {
    strategy: registration.strategy,
    authorizationServerUrl: registration.authorizationServerUrl,
    clientInformation: structuredClone(registration.clientInformation),
  };
}

export function cloneDiscovery(discovery: OAuthDiscoveryRecord): OAuthDiscoveryRecord {
  return {
    authorizationServerUrl: discovery.authorizationServerUrl,
    fetchedAt: discovery.fetchedAt,
    ...(discovery.authorizationServerMetadata
      ? { authorizationServerMetadata: structuredClone(discovery.authorizationServerMetadata) }
      : {}),
    ...(discovery.resourceMetadata
      ? { resourceMetadata: structuredClone(discovery.resourceMetadata) }
      : {}),
  };
}

/** RFC 6749 scope-token = 1*NQCHAR。 */
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function requireOAuthScopeToken(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !SCOPE_TOKEN_PATTERN.test(value)) {
    throw new TypeError(`${fieldName} must be a valid OAuth scope token.`);
  }
  return value;
}

/** 归一化为去重、排序的单个 scope token 列表。 */
export function normalizeChallengedScopes(scopes: readonly string[]): string[] {
  const values = scopes.map((scope, index) =>
    requireOAuthScopeToken(scope, `challengedScopes[${index}]`)
  );
  return [...new Set(values)].sort();
}

/** append-only 追加：已有条目保持不动，只并入新 scope。 */
export function addChallengedScopes(
  existing: readonly string[],
  added: readonly string[],
): string[] {
  return normalizeChallengedScopes([...existing, ...added]);
}
