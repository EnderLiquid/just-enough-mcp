import type {
  AuthorizationServerMetadata,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientRegistration,
  OAuthDiscoveryRecord,
} from "./credential-record.ts";
import type { OAuthIdentity } from "./identity.ts";
import {
  applyOAuthAuthorization,
  applyOAuthRefresh,
  beginOAuthAuthorization,
  captureOAuthCredentialFence,
  clearOAuthTokens,
  cloneOAuthCredentialState,
  isOAuthCredentialFenceCurrent,
  normalizeOAuthScope,
  oauthTokenSatisfiesScope,
  toOAuthTokenSnapshot,
  type OAuthCredentialFence,
  type OAuthCredentialState,
  type OAuthTokenSnapshot,
  type OAuthTokenUpdate,
} from "./credential-state.ts";
import {
  InMemoryOAuthCredentialRepository,
  type OAuthCredentialRepository,
} from "./credential-repository.ts";
import type {
  OAuthDiscoveryOperation,
  OAuthRegistrationOperation,
} from "./oauth-protocol-types.ts";

/** broker 侧额外 reserve 的 access token 剩余寿命；与调用方 minRemainingMs 相加。 */
export const OAUTH_TOKEN_SAFETY_WINDOW_MS = 30_000;

/** discovery 缓存 TTL；refresh/token 路径过期后重新 discovery，显式 authorize 总是实时获取。 */
export const OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface OAuthRefreshRequest {
  readonly identity: OAuthIdentity;
  readonly refreshToken: string;
  readonly credentialRevision: number;
  readonly authEpoch: number;
  /** DCR 注册记录；Phase 5 authorize 之前的旧记录可能缺失。 */
  readonly registration?: OAuthClientRegistration;
  /** 与 registration 对应 AS 一致的 discovery metadata。 */
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
}

export type OAuthRefreshOperation = (
  request: OAuthRefreshRequest,
) => Promise<OAuthTokenUpdate>;

export interface OAuthTokenAcquisitionOptions {
  /** 要求返回的 access token 至少还剩多少毫秒；broker 会再 reserve safety window。 */
  readonly minRemainingMs?: number;
  /** 该 revision 已经被 resource server 拒绝；相同 revision 不得直接再次发放。 */
  readonly rejectedCredentialRevision?: number;
  /** 本次请求所需的 scope；scope 不属于 credential identity。 */
  readonly scope?: string;
  /** 测试或 broker clock 注入用的当前时间。 */
  readonly now?: number;
}

export interface OAuthTokenCoordinatorOptions {
  readonly refresh: OAuthRefreshOperation;
  readonly discover?: OAuthDiscoveryOperation;
  readonly register?: OAuthRegistrationOperation;
  readonly repository?: OAuthCredentialRepository;
  readonly now?: () => number;
  readonly tokenSafetyWindowMs?: number;
  readonly discoveryTtlMs?: number;
}

export interface OAuthCredentialView {
  readonly credentialRevision: number;
  readonly authEpoch: number;
  readonly hasAccessToken: boolean;
  readonly accessTokenExpiresAt?: number;
  readonly hasRefreshToken: boolean;
  readonly scope?: string;
}

export type OAuthLogoutRefusalReason = "revision-superseded" | "refresh-in-flight";

export interface OAuthLogoutResult {
  readonly applied: boolean;
  /** 仅当 applied 为 false 时给出拒绝原因。 */
  readonly reason?: OAuthLogoutRefusalReason;
  readonly credential: OAuthCredentialView;
}

export type OAuthAuthorizationRequiredReason = "credential-rejected" | "client-rejected";

export class OAuthAuthorizationRequiredError extends Error {
  readonly code = "authorization-required" as const;
  readonly reason?: OAuthAuthorizationRequiredReason;

  constructor(
    options: { cause?: unknown; reason?: OAuthAuthorizationRequiredReason } = {},
  ) {
    super(
      "OAuth authorization is required.",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "OAuthAuthorizationRequiredError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export class OAuthCredentialChangedError extends Error {
  readonly code = "credential-changed" as const;

  constructor() {
    super("OAuth credentials changed while the operation was in flight.");
    this.name = "OAuthCredentialChangedError";
  }
}

/** Marks an OAuth token endpoint response that permanently invalidates the refresh credential. */
export type OAuthPermanentRefreshReason = "invalid-grant" | "invalid-scope";

export class OAuthPermanentRefreshError extends Error {
  readonly code = "permanent-refresh-error" as const;
  readonly reason: OAuthPermanentRefreshReason;

  constructor(
    message = "OAuth refresh credential was rejected.",
    options: { cause?: unknown; reason?: OAuthPermanentRefreshReason } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthPermanentRefreshError";
    this.reason = options.reason ?? "invalid-grant";
  }
}

/** Marks an AS response that permanently invalidates the client registration. */
export class OAuthClientRejectedError extends Error {
  readonly code = "client-rejected" as const;

  constructor(message = "OAuth client registration was rejected.", options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthClientRejectedError";
  }
}

/** 无法确认错误的协议失败：网络、timeout、5xx、无法解析的响应；不修改 credential。 */
export class OAuthTemporaryProtocolError extends Error {
  readonly code = "temporary-protocol-error" as const;

  constructor(
    message = "OAuth protocol operation failed temporarily.",
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthTemporaryProtocolError";
  }
}

/** 请求的 scope 超出当前授权；broker 不发起 scope 扩张型 refresh。 */
export class OAuthScopeNotGrantedError extends Error {
  readonly code = "scope-not-granted" as const;
  readonly scope: string;

  constructor(scope: string) {
    super("Requested OAuth scope is not granted by the current authorization.");
    this.name = "OAuthScopeNotGrantedError";
    this.scope = scope;
  }
}

/**
 * Broker credential coordinator. Repository commits are durable-before-visible and
 * refresh/discovery/registration work stays outside the repository mutation queue.
 * Revision + epoch CAS prevents late refresh/authorization results from overwriting
 * logout or newer grants.
 */
export class OAuthTokenCoordinator {
  private readonly refreshFlights = new Map<string, Promise<OAuthTokenSnapshot>>();
  private readonly discoveryFlights = new Map<string, Promise<OAuthDiscoveryRecord | undefined>>();
  private readonly registrationFlights = new Map<string, Promise<OAuthClientRegistration>>();
  private readonly options: OAuthTokenCoordinatorOptions;
  private readonly repository: OAuthCredentialRepository;
  private readonly now: () => number;
  private readonly tokenSafetyWindowMs: number;
  private readonly discoveryTtlMs: number;

  constructor(options: OAuthTokenCoordinatorOptions) {
    this.options = options;
    this.repository = options.repository ?? new InMemoryOAuthCredentialRepository();
    this.now = options.now ?? (() => Date.now());
    this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? OAUTH_TOKEN_SAFETY_WINDOW_MS;
    this.discoveryTtlMs = options.discoveryTtlMs ?? OAUTH_DISCOVERY_TTL_MS;
    assertNonNegativeFinite(this.tokenSafetyWindowMs, "tokenSafetyWindowMs");
    assertNonNegativeFinite(this.discoveryTtlMs, "discoveryTtlMs");
  }

  /** Seeds/restores one authorization record. Production brokers normally load it through the repository. */
  async restore(identity: OAuthIdentity, state: OAuthCredentialState): Promise<void> {
    const restored = cloneOAuthCredentialState(state);
    await this.repository.mutate(identity, () => ({ state: restored, result: undefined }));
  }

  /** Broker-internal diagnostics/fencing only; secrets are represented as booleans. */
  async getCredentialView(identity: OAuthIdentity): Promise<OAuthCredentialView> {
    return this.toCredentialView(await this.repository.read(identity));
  }

  async beginAuthorization(identity: OAuthIdentity): Promise<OAuthCredentialFence> {
    return this.repository.mutate(identity, current => {
      const started = beginOAuthAuthorization(current);
      return {
        state: started.state,
        result: { ...started.fence },
      };
    });
  }

  /**
   * 提交授权结果；成功提交时同时清空该 identity 的追加 scope 集合。
   */
  async commitAuthorization(
    identity: OAuthIdentity,
    fence: OAuthCredentialFence,
    update: OAuthTokenUpdate,
  ): Promise<boolean> {
    return this.repository.mutateRecord(identity, current => {
      const committed = applyOAuthAuthorization(
        current.authorization,
        fence,
        canonicalizeUpdate(update),
      );
      if (!committed) {
        return { record: current, result: false, changed: false };
      }
      return {
        record: { ...current, authorization: committed, challengedScopes: [] },
        result: true,
      };
    });
  }

  /** authorize 解析 scope 时读取该 identity 的追加集合。 */
  async getChallengedScopes(identity: OAuthIdentity): Promise<readonly string[]> {
    const record = await this.repository.readRecord(identity);
    return [...record.challengedScopes];
  }

  /** AS 在 authorize 事务里拒绝 scope 时只清空追加集合；token 与 registration 不动。 */
  async discardChallengedScopes(identity: OAuthIdentity): Promise<void> {
    await this.repository.mutateRecord(identity, current => ({
      record: current.challengedScopes.length === 0
        ? current
        : { ...current, challengedScopes: [] },
      result: undefined,
      changed: current.challengedScopes.length > 0,
    }));
  }

  /** authorize 事务发现 client 身份被拒时，按 fence 清 token + registration + challengedScopes。 */
  async clearClientAuthorization(
    identity: OAuthIdentity,
    fence: OAuthCredentialFence,
  ): Promise<boolean> {
    return this.clearCredentials(identity, fence, "client");
  }

  async getAccessToken(
    identity: OAuthIdentity,
    options: OAuthTokenAcquisitionOptions = {},
  ): Promise<OAuthTokenSnapshot> {
    const minRemainingMs = options.minRemainingMs ?? 0;
    assertNonNegativeFinite(minRemainingMs, "minRemainingMs");
    if (options.rejectedCredentialRevision !== undefined) {
      assertNonNegativeSafeInteger(
        options.rejectedCredentialRevision,
        "rejectedCredentialRevision",
      );
    }
    const scope = options.scope === undefined
      ? undefined
      : normalizeOAuthScope(options.scope);

    const state = await this.repository.read(identity);
    const token = toOAuthTokenSnapshot(state);
    const rejectedCurrentRevision = options.rejectedCredentialRevision !== undefined
      && options.rejectedCredentialRevision === state.credentialRevision;
    const now = options.now ?? this.now();
    assertFinite(now, "now");

    if (token && !rejectedCurrentRevision
      && token.accessTokenExpiresAt - now >= minRemainingMs + this.tokenSafetyWindowMs
      && state.tokens && oauthTokenSatisfiesScope(state.tokens, scope)) {
      return token;
    }

    // 请求 scope 超出已存授权时不得尝试 refresh：RFC 6749 refresh 不能扩张 scope，
    // 只有显式 authorize 才能扩大授权。
    if (state.tokens && scope !== undefined && !oauthTokenSatisfiesScope(state.tokens, scope)) {
      throw new OAuthScopeNotGrantedError(scope);
    }

    if (!state.tokens?.refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    const refreshed = await this.refresh(identity);
    const refreshedState = await this.repository.read(identity);
    if (!refreshedState.tokens
      || refreshedState.credentialRevision !== refreshed.credentialRevision) {
      throw new OAuthAuthorizationRequiredError();
    }
    if (scope !== undefined && !oauthTokenSatisfiesScope(refreshedState.tokens, scope)) {
      throw new OAuthScopeNotGrantedError(scope);
    }
    return refreshed;
  }

  /**
   * 解析（或从缓存读取）identity 的 discovery 记录。缓存过期时重新获取；
   * 获取失败但有缓存时沿用缓存（stale-if-error）；两者都不可用时抛错。
   */
  async ensureDiscovery(
    identity: OAuthIdentity,
    options: { force?: boolean; resourceMetadataUrl?: string } = {},
  ): Promise<OAuthDiscoveryRecord | undefined> {
    const key = identity.key;
    const existing = this.discoveryFlights.get(key);
    if (existing) {
      return existing;
    }
    const flight = Promise.resolve().then(() => this.runDiscovery(
      identity,
      options.force === true,
      options.resourceMetadataUrl,
    ));
    this.discoveryFlights.set(key, flight);
    flight.then(
      () => this.clearFlight(this.discoveryFlights, key, flight),
      () => this.clearFlight(this.discoveryFlights, key, flight),
    );
    return flight;
  }

  /**
   * 确保 identity 有 client registration；DCR 按 identity single-flight。
   * 显式 authorize 传入 force 时会先强制刷新 discovery。
   */
  async ensureRegistration(
    identity: OAuthIdentity,
    clientMetadata: OAuthClientMetadata,
    options: { force?: boolean; scope?: string } = {},
  ): Promise<OAuthClientRegistration> {
    const key = identity.key;
    const existing = this.registrationFlights.get(key);
    if (existing) {
      return existing;
    }
    const flight = Promise.resolve().then(() => this.runRegistration(
      identity,
      clientMetadata,
      options.force === true,
      options.scope,
    ));
    this.registrationFlights.set(key, flight);
    flight.then(
      () => this.clearFlight(this.registrationFlights, key, flight),
      () => this.clearFlight(this.registrationFlights, key, flight),
    );
    return flight;
  }

  async logout(
    identity: OAuthIdentity,
    expectedCredentialRevision?: number,
  ): Promise<OAuthLogoutResult> {
    if (expectedCredentialRevision !== undefined) {
      assertNonNegativeSafeInteger(expectedCredentialRevision, "expectedCredentialRevision");
    }

    return this.repository.mutateRecord<OAuthLogoutResult>(identity, current => {
      const currentView = this.toCredentialView(current.authorization);
      if (expectedCredentialRevision !== undefined
        && current.authorization.credentialRevision !== expectedCredentialRevision) {
        return {
          record: current,
          result: { applied: false, reason: "revision-superseded", credential: currentView },
          changed: false,
        };
      }
      if (expectedCredentialRevision !== undefined && this.refreshFlights.has(identity.key)) {
        return {
          record: current,
          result: { applied: false, reason: "refresh-in-flight", credential: currentView },
          changed: false,
        };
      }

      const result = clearOAuthTokens(current.authorization, expectedCredentialRevision);
      return {
        record: { ...current, authorization: result.state },
        result: { applied: result.applied, credential: this.toCredentialView(result.state) },
        changed: result.applied,
      };
    });
  }

  private refresh(identity: OAuthIdentity): Promise<OAuthTokenSnapshot> {
    const key = identity.key;
    const existing = this.refreshFlights.get(key);
    if (existing) {
      return existing;
    }

    // Publish the flight before invoking user/OAuth code so synchronous re-entry joins it.
    const flight = Promise.resolve().then(() => this.runRefresh(identity));
    this.refreshFlights.set(key, flight);
    flight.then(
      () => this.clearFlight(this.refreshFlights, key, flight),
      () => this.clearFlight(this.refreshFlights, key, flight),
    );
    return flight;
  }

  private async runRefresh(identity: OAuthIdentity): Promise<OAuthTokenSnapshot> {
    const record = await this.repository.readRecord(identity);
    const refreshToken = record.authorization.tokens?.refreshToken;
    if (!refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    const fence = captureOAuthCredentialFence(record.authorization);
    const discovery = await this.ensureDiscovery(identity);
    const registration = record.registration;
    const metadata = discovery && registration
      && discovery.authorizationServerUrl === registration.authorizationServerUrl
      ? discovery.authorizationServerMetadata
      : undefined;

    let update: OAuthTokenUpdate;
    try {
      update = await this.options.refresh({
        identity,
        refreshToken,
        credentialRevision: fence.credentialRevision,
        authEpoch: fence.authEpoch,
        ...(registration ? { registration } : {}),
        ...(metadata ? { authorizationServerMetadata: metadata } : {}),
      });
    } catch (error) {
      if (error instanceof OAuthPermanentRefreshError) {
        const kind = error.reason === "invalid-scope" ? "scope" : "credential";
        if (!await this.clearCredentials(identity, fence, kind)) {
          throw new OAuthCredentialChangedError();
        }
        throw new OAuthAuthorizationRequiredError({ cause: error, reason: "credential-rejected" });
      }
      if (error instanceof OAuthClientRejectedError) {
        if (!await this.clearCredentials(identity, fence, "client")) {
          throw new OAuthCredentialChangedError();
        }
        throw new OAuthAuthorizationRequiredError({ cause: error, reason: "client-rejected" });
      }
      throw error;
    }

    const canonicalUpdate = canonicalizeUpdate(update);
    return this.repository.mutate(identity, current => {
      const committed = applyOAuthRefresh(current, fence, canonicalUpdate);
      if (!committed) {
        throw new OAuthCredentialChangedError();
      }
      const snapshot = toOAuthTokenSnapshot(committed);
      if (!snapshot) {
        throw new Error("OAuth refresh committed without an access token.");
      }
      return { state: committed, result: snapshot };
    });
  }

  private async runDiscovery(
    identity: OAuthIdentity,
    force: boolean,
    resourceMetadataUrl?: string,
  ): Promise<OAuthDiscoveryRecord | undefined> {
    const record = await this.repository.readRecord(identity);
    const cached = record.discovery;
    if (!force && cached && this.now() - cached.fetchedAt <= this.discoveryTtlMs) {
      return cached;
    }
    const operation = this.options.discover;
    if (!operation) {
      return cached;
    }

    try {
      const result = await operation({
        identity,
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
      });
      const next: OAuthDiscoveryRecord = {
        authorizationServerUrl: result.authorizationServerUrl,
        fetchedAt: this.now(),
        ...(result.authorizationServerMetadata
          ? { authorizationServerMetadata: result.authorizationServerMetadata }
          : {}),
        ...(result.resourceMetadata ? { resourceMetadata: result.resourceMetadata } : {}),
      };
      return await this.repository.mutateRecord(identity, current => ({
        record: { ...current, discovery: next },
        result: next,
      }));
    } catch (error) {
      if (cached) {
        return cached;
      }
      throw error;
    }
  }

  private async runRegistration(
    identity: OAuthIdentity,
    clientMetadata: OAuthClientMetadata,
    force: boolean,
    scope: string | undefined,
  ): Promise<OAuthClientRegistration> {
    const record = await this.repository.readRecord(identity);
    if (!force && record.registration) {
      return record.registration;
    }
    const discovery = await this.ensureDiscovery(identity, { force });
    const operation = this.options.register;
    if (!operation) {
      throw new OAuthTemporaryProtocolError(
        "OAuth client registration is not available in this broker.",
      );
    }

    const authorizationServerUrl = discovery?.authorizationServerUrl ?? identity.resourceUrl;
    const clientInformation = await operation({
      identity,
      authorizationServerUrl,
      ...(discovery?.authorizationServerMetadata
        ? { authorizationServerMetadata: discovery.authorizationServerMetadata }
        : {}),
      clientMetadata,
      ...(scope === undefined ? {} : { scope }),
    });
    const registration: OAuthClientRegistration = {
      strategy: "dcr",
      authorizationServerUrl,
      clientInformation,
    };
    return this.repository.mutateRecord(identity, current => ({
      record: { ...current, registration },
      result: registration,
    }));
  }

  /** 按类别清除 credential；client 类别同时失效 registration 与 challengedScopes，scope 类别只清 challengedScopes。 */
  private clearCredentials(
    identity: OAuthIdentity,
    fence: OAuthCredentialFence,
    kind: "credential" | "client" | "scope",
  ): Promise<boolean> {
    return this.repository.mutateRecord(identity, current => {
      if (!isOAuthCredentialFenceCurrent(current.authorization, fence)) {
        return { record: current, result: false, changed: false };
      }
      const result = clearOAuthTokens(current.authorization, fence.credentialRevision);
      const next = kind === "client"
        ? { ...current, authorization: result.state, registration: undefined, challengedScopes: [] }
        : kind === "scope"
          ? { ...current, authorization: result.state, challengedScopes: [] }
          : { ...current, authorization: result.state };
      return { record: next, result: result.applied, changed: result.applied };
    });
  }

  private clearFlight<T>(
    flights: Map<string, Promise<T>>,
    key: string,
    flight: Promise<T>,
  ): void {
    if (flights.get(key) === flight) {
      flights.delete(key);
    }
  }

  private toCredentialView(state: OAuthCredentialState): OAuthCredentialView {
    return {
      credentialRevision: state.credentialRevision,
      authEpoch: state.authEpoch,
      hasAccessToken: state.tokens !== undefined,
      ...(state.tokens ? { accessTokenExpiresAt: state.tokens.accessTokenExpiresAt } : {}),
      hasRefreshToken: state.tokens?.refreshToken !== undefined,
      ...(state.tokens?.scope === undefined ? {} : { scope: state.tokens.scope }),
    };
  }
}

function canonicalizeUpdate(update: OAuthTokenUpdate): OAuthTokenUpdate {
  return {
    ...update,
    ...(update.scope === undefined ? {} : { scope: normalizeOAuthScope(update.scope) }),
  };
}

function assertFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number.`);
  }
}

function assertNonNegativeFinite(value: number, fieldName: string): void {
  assertFinite(value, fieldName);
  if (value < 0) {
    throw new TypeError(`${fieldName} must be non-negative.`);
  }
}

function assertNonNegativeSafeInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
}
