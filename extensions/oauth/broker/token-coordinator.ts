import type { OAuthIdentity } from "./identity.js";
import {
  applyOAuthAuthorization,
  applyOAuthRefresh,
  beginOAuthAuthorization,
  captureOAuthCredentialFence,
  clearOAuthTokens,
  cloneOAuthCredentialState,
  createOAuthCredentialState,
  toOAuthTokenSnapshot,
  type OAuthCredentialFence,
  type OAuthCredentialState,
  type OAuthTokenSnapshot,
  type OAuthTokenUpdate,
} from "./credential-state.js";

export interface OAuthRefreshRequest {
  readonly identity: OAuthIdentity;
  readonly refreshToken: string;
  readonly credentialRevision: number;
  readonly authEpoch: number;
}

export type OAuthRefreshOperation = (
  request: OAuthRefreshRequest,
) => Promise<OAuthTokenUpdate>;

export interface OAuthTokenAcquisitionOptions {
  /** 要求返回的 access token 至少还剩多少毫秒。 */
  readonly minRemainingMs?: number;
  /** 该 revision 已经被 resource server 拒绝；相同 revision 不得直接再次发放。 */
  readonly rejectedCredentialRevision?: number;
  /** 测试或 broker clock 注入用的当前时间。 */
  readonly now?: number;
}

export interface OAuthTokenCoordinatorOptions {
  readonly refresh: OAuthRefreshOperation;
  readonly now?: () => number;
}

export interface OAuthCredentialView {
  readonly credentialRevision: number;
  readonly authEpoch: number;
  readonly hasAccessToken: boolean;
  readonly accessTokenExpiresAt?: number;
  readonly hasRefreshToken: boolean;
}

export interface OAuthLogoutResult {
  readonly applied: boolean;
  readonly credential: OAuthCredentialView;
}

export class OAuthAuthorizationRequiredError extends Error {
  readonly code = "authorization-required" as const;

  constructor() {
    super("OAuth authorization is required.");
    this.name = "OAuthAuthorizationRequiredError";
  }
}

export class OAuthCredentialChangedError extends Error {
  readonly code = "credential-changed" as const;

  constructor() {
    super("OAuth credentials changed while the operation was in flight.");
    this.name = "OAuthCredentialChangedError";
  }
}

/**
 * Phase 1 的 broker 内核：只处理 identity 对应的 credential snapshot 和并发 fencing。
 *
 * 这里故意不包含 HTTP、文件持久化、OAuth protocol 或 MCP connection。所有 state map
 * 操作都在 await 之间以同步步骤完成；跨 await 的结果必须通过 revision + epoch fencing
 * 才能提交，因此后续可以把同一内核放进独立 broker，而不把 session lock 带进去。
 */
export class OAuthTokenCoordinator {
  private readonly states = new Map<string, OAuthCredentialState>();
  private readonly refreshFlights = new Map<string, Promise<OAuthTokenSnapshot>>();
  private readonly now: () => number;

  constructor(private readonly options: OAuthTokenCoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 从 broker-owned storage 恢复一条 record；不会把 secret 暴露给 token snapshot。 */
  restore(identity: OAuthIdentity, state: OAuthCredentialState): void {
    this.states.set(identity.key, cloneOAuthCredentialState(state));
  }

  /** 仅供 broker 内部诊断/fencing；不得序列化到 session status 或用户结果。 */
  getCredentialView(identity: OAuthIdentity): OAuthCredentialView {
    return this.toCredentialView(this.getState(identity));
  }

  beginAuthorization(identity: OAuthIdentity): OAuthCredentialFence {
    const current = this.getState(identity);
    const started = beginOAuthAuthorization(current);
    this.states.set(identity.key, started.state);
    return { ...started.fence };
  }

  commitAuthorization(
    identity: OAuthIdentity,
    fence: OAuthCredentialFence,
    update: OAuthTokenUpdate,
  ): boolean {
    const current = this.getState(identity);
    const committed = applyOAuthAuthorization(current, fence, update);
    if (!committed) {
      return false;
    }
    this.states.set(identity.key, committed);
    return true;
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

    const state = this.getState(identity);
    const token = toOAuthTokenSnapshot(state);
    const rejectedCurrentRevision = options.rejectedCredentialRevision !== undefined
      && options.rejectedCredentialRevision === state.credentialRevision;
    const now = options.now ?? this.now();
    assertFinite(now, "now");

    if (token && !rejectedCurrentRevision
      && token.accessTokenExpiresAt - now >= minRemainingMs) {
      return token;
    }

    if (!state.tokens?.refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    return this.refresh(identity);
  }

  logout(identity: OAuthIdentity, expectedCredentialRevision?: number): OAuthLogoutResult {
    if (expectedCredentialRevision !== undefined) {
      assertNonNegativeSafeInteger(expectedCredentialRevision, "expectedCredentialRevision");
    }

    const current = this.getState(identity);
    const result = clearOAuthTokens(current, expectedCredentialRevision);
    if (result.applied) {
      this.states.set(identity.key, result.state);
    }
    return {
      applied: result.applied,
      credential: this.toCredentialView(result.state),
    };
  }

  private refresh(identity: OAuthIdentity): Promise<OAuthTokenSnapshot> {
    const key = identity.key;
    const existing = this.refreshFlights.get(key);
    if (existing) {
      return existing;
    }

    // 先把 flight 放进 map，再开始执行 refresh callback。这样即使 callback
    // 同步重入 getAccessToken，也会加入当前 flight，而不是启动第二次 refresh。
    const flight = Promise.resolve().then(() => this.runRefresh(identity));
    this.refreshFlights.set(key, flight);
    flight.then(
      () => this.clearRefreshFlight(key, flight),
      () => this.clearRefreshFlight(key, flight),
    );
    return flight;
  }

  private async runRefresh(identity: OAuthIdentity): Promise<OAuthTokenSnapshot> {
    const key = identity.key;
    const state = this.getState(identity);
    const refreshToken = state.tokens?.refreshToken;
    if (!refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    const fence = captureOAuthCredentialFence(state);
    const update = await this.options.refresh({
      identity,
      refreshToken,
      credentialRevision: fence.credentialRevision,
      authEpoch: fence.authEpoch,
    });
    const current = this.getState(identity);
    const committed = applyOAuthRefresh(current, fence, update);
    if (!committed) {
      throw new OAuthCredentialChangedError();
    }

    this.states.set(key, committed);
    const snapshot = toOAuthTokenSnapshot(committed);
    if (!snapshot) {
      throw new Error("OAuth refresh committed without an access token.");
    }
    return snapshot;
  }

  private clearRefreshFlight(
    key: string,
    flight: Promise<OAuthTokenSnapshot>,
  ): void {
    if (this.refreshFlights.get(key) === flight) {
      this.refreshFlights.delete(key);
    }
  }

  private getState(identity: OAuthIdentity): OAuthCredentialState {
    const existing = this.states.get(identity.key);
    if (existing) {
      return existing;
    }

    const created = createOAuthCredentialState();
    this.states.set(identity.key, created);
    return created;
  }

  private toCredentialView(state: OAuthCredentialState): OAuthCredentialView {
    return {
      credentialRevision: state.credentialRevision,
      authEpoch: state.authEpoch,
      hasAccessToken: state.tokens !== undefined,
      ...(state.tokens ? { accessTokenExpiresAt: state.tokens.accessTokenExpiresAt } : {}),
      hasRefreshToken: state.tokens?.refreshToken !== undefined,
    };
  }
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
