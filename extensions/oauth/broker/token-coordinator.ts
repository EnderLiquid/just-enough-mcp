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

export interface OAuthRefreshRequest {
  readonly identity: OAuthIdentity;
  readonly refreshToken: string;
  readonly credentialRevision: number;
  readonly authEpoch: number;
  readonly scope?: string;
}

export type OAuthRefreshOperation = (
  request: OAuthRefreshRequest,
) => Promise<OAuthTokenUpdate>;

export interface OAuthTokenAcquisitionOptions {
  /** 要求返回的 access token 至少还剩多少毫秒。 */
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
  readonly repository?: OAuthCredentialRepository;
  readonly now?: () => number;
}

export interface OAuthCredentialView {
  readonly credentialRevision: number;
  readonly authEpoch: number;
  readonly hasAccessToken: boolean;
  readonly accessTokenExpiresAt?: number;
  readonly hasRefreshToken: boolean;
  readonly scope?: string;
}

export interface OAuthLogoutResult {
  readonly applied: boolean;
  readonly credential: OAuthCredentialView;
}

export class OAuthAuthorizationRequiredError extends Error {
  readonly code = "authorization-required" as const;

  constructor(options: { cause?: unknown } = {}) {
    super(
      "OAuth authorization is required.",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
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

/** Marks an OAuth token endpoint response that permanently invalidates the refresh credential. */
export class OAuthPermanentRefreshError extends Error {
  readonly code = "permanent-refresh-error" as const;

  constructor(message = "OAuth refresh credential was rejected.", options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthPermanentRefreshError";
  }
}

export class OAuthRefreshUnavailableError extends Error {
  readonly code = "refresh-unavailable" as const;

  constructor() {
    super("OAuth refresh protocol is not available in this broker phase.");
    this.name = "OAuthRefreshUnavailableError";
  }
}

/**
 * Broker credential coordinator. Repository commits are durable-before-visible and
 * refresh work stays outside the repository mutation queue. Revision + epoch CAS
 * prevents late refresh/authorization results from overwriting logout or newer grants.
 */
export class OAuthTokenCoordinator {
  private readonly refreshFlights = new Map<string, Promise<OAuthTokenSnapshot>>();
  private readonly options: OAuthTokenCoordinatorOptions;
  private readonly repository: OAuthCredentialRepository;
  private readonly now: () => number;

  constructor(options: OAuthTokenCoordinatorOptions) {
    this.options = options;
    this.repository = options.repository ?? new InMemoryOAuthCredentialRepository();
    this.now = options.now ?? (() => Date.now());
  }

  /** Seeds/restores one record. Production brokers normally load it through the repository. */
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

  async commitAuthorization(
    identity: OAuthIdentity,
    fence: OAuthCredentialFence,
    update: OAuthTokenUpdate,
  ): Promise<boolean> {
    return this.repository.mutate(identity, current => {
      const committed = applyOAuthAuthorization(current, fence, canonicalizeUpdate(update));
      if (!committed) {
        return { state: current, result: false, changed: false };
      }
      return { state: committed, result: true };
    });
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
      && token.accessTokenExpiresAt - now >= minRemainingMs
      && state.tokens && oauthTokenSatisfiesScope(state.tokens, scope)) {
      return token;
    }

    if (!state.tokens?.refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    const refreshed = await this.refresh(identity, scope);
    const refreshedState = await this.repository.read(identity);
    if (!refreshedState.tokens
      || refreshedState.credentialRevision !== refreshed.credentialRevision
      || !oauthTokenSatisfiesScope(refreshedState.tokens, scope)) {
      throw new OAuthAuthorizationRequiredError();
    }
    return refreshed;
  }

  async logout(
    identity: OAuthIdentity,
    expectedCredentialRevision?: number,
  ): Promise<OAuthLogoutResult> {
    if (expectedCredentialRevision !== undefined) {
      assertNonNegativeSafeInteger(expectedCredentialRevision, "expectedCredentialRevision");
    }

    return this.repository.mutate(identity, current => {
      const result = clearOAuthTokens(current, expectedCredentialRevision);
      return {
        state: result.state,
        result: {
          applied: result.applied,
          credential: this.toCredentialView(result.state),
        },
        changed: result.applied,
      };
    });
  }

  private refresh(identity: OAuthIdentity, scope: string | undefined): Promise<OAuthTokenSnapshot> {
    const key = identity.key;
    const existing = this.refreshFlights.get(key);
    if (existing) {
      return existing;
    }

    // Publish the flight before invoking user/OAuth code so synchronous re-entry joins it.
    const flight = Promise.resolve().then(() => this.runRefresh(identity, scope));
    this.refreshFlights.set(key, flight);
    flight.then(
      () => this.clearRefreshFlight(key, flight),
      () => this.clearRefreshFlight(key, flight),
    );
    return flight;
  }

  private async runRefresh(
    identity: OAuthIdentity,
    scope: string | undefined,
  ): Promise<OAuthTokenSnapshot> {
    const state = await this.repository.read(identity);
    const refreshToken = state.tokens?.refreshToken;
    if (!refreshToken) {
      throw new OAuthAuthorizationRequiredError();
    }

    const fence = captureOAuthCredentialFence(state);
    let update: OAuthTokenUpdate;
    try {
      update = await this.options.refresh({
        identity,
        refreshToken,
        credentialRevision: fence.credentialRevision,
        authEpoch: fence.authEpoch,
        ...(scope === undefined ? {} : { scope }),
      });
    } catch (error) {
      if (!(error instanceof OAuthPermanentRefreshError)) {
        throw error;
      }
      const cleared = await this.repository.mutate(identity, current => {
        if (!isOAuthCredentialFenceCurrent(current, fence)) {
          return { state: current, result: false, changed: false };
        }
        const result = clearOAuthTokens(current, fence.credentialRevision);
        return { state: result.state, result: result.applied, changed: result.applied };
      });
      if (!cleared) {
        throw new OAuthCredentialChangedError();
      }
      throw new OAuthAuthorizationRequiredError({ cause: error });
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

  private clearRefreshFlight(key: string, flight: Promise<OAuthTokenSnapshot>): void {
    if (this.refreshFlights.get(key) === flight) {
      this.refreshFlights.delete(key);
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
