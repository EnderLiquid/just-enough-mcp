export interface OAuthTokenCredentials {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly refreshToken?: string;
}

export interface OAuthTokenUpdate {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  /** 未提供时，refresh flow 保留现有 refresh token；authorization flow 则不设置。 */
  readonly refreshToken?: string;
}

export interface OAuthCredentialState {
  readonly tokens?: OAuthTokenCredentials;
  readonly credentialRevision: number;
  readonly authEpoch: number;
}

export interface OAuthCredentialStateInit {
  readonly tokens?: OAuthTokenCredentials;
  readonly credentialRevision?: number;
  readonly authEpoch?: number;
}

export interface OAuthTokenSnapshot {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly credentialRevision: number;
}

export interface OAuthCredentialFence {
  readonly credentialRevision: number;
  readonly authEpoch: number;
}

export interface OAuthAuthorizationStart {
  readonly state: OAuthCredentialState;
  readonly fence: OAuthCredentialFence;
}

export interface OAuthTokenClearResult {
  readonly state: OAuthCredentialState;
  readonly applied: boolean;
}

function assertCounter(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
}

function assertTokenCredentials(tokens: OAuthTokenCredentials, fieldName = "tokens"): void {
  if (typeof tokens.accessToken !== "string" || tokens.accessToken.length === 0) {
    throw new TypeError(`${fieldName}.accessToken must be a non-empty string.`);
  }
  if (!Number.isFinite(tokens.accessTokenExpiresAt)) {
    throw new TypeError(`${fieldName}.accessTokenExpiresAt must be a finite number.`);
  }
  if (tokens.refreshToken !== undefined && (
    typeof tokens.refreshToken !== "string" || tokens.refreshToken.length === 0
  )) {
    throw new TypeError(`${fieldName}.refreshToken must be a non-empty string when provided.`);
  }
}

export function createOAuthCredentialState(
  init: OAuthCredentialStateInit = {},
): OAuthCredentialState {
  const credentialRevision = init.credentialRevision ?? 0;
  const authEpoch = init.authEpoch ?? 0;
  assertCounter(credentialRevision, "credentialRevision");
  assertCounter(authEpoch, "authEpoch");
  if (init.tokens !== undefined) {
    assertTokenCredentials(init.tokens);
  }

  return cloneOAuthCredentialState({
    credentialRevision,
    authEpoch,
    ...(init.tokens ? { tokens: init.tokens } : {}),
  });
}

export function cloneOAuthCredentialState(state: OAuthCredentialState): OAuthCredentialState {
  assertCounter(state.credentialRevision, "credentialRevision");
  assertCounter(state.authEpoch, "authEpoch");
  if (state.tokens !== undefined) {
    assertTokenCredentials(state.tokens);
  }

  return {
    credentialRevision: state.credentialRevision,
    authEpoch: state.authEpoch,
    ...(state.tokens ? { tokens: { ...state.tokens } } : {}),
  };
}

export function captureOAuthCredentialFence(
  state: OAuthCredentialState,
): OAuthCredentialFence {
  return {
    credentialRevision: state.credentialRevision,
    authEpoch: state.authEpoch,
  };
}

export function isOAuthCredentialFenceCurrent(
  state: OAuthCredentialState,
  fence: OAuthCredentialFence,
): boolean {
  return state.credentialRevision === fence.credentialRevision
    && state.authEpoch === fence.authEpoch;
}

export function toOAuthTokenSnapshot(
  state: OAuthCredentialState,
): OAuthTokenSnapshot | undefined {
  if (!state.tokens) {
    return undefined;
  }
  return {
    accessToken: state.tokens.accessToken,
    accessTokenExpiresAt: state.tokens.accessTokenExpiresAt,
    credentialRevision: state.credentialRevision,
  };
}

export function beginOAuthAuthorization(
  state: OAuthCredentialState,
): OAuthAuthorizationStart {
  const nextState: OAuthCredentialState = {
    ...cloneOAuthCredentialState(state),
    authEpoch: incrementCounter(state.authEpoch, "authEpoch"),
  };
  assertCounter(nextState.authEpoch, "authEpoch");
  return {
    state: nextState,
    fence: captureOAuthCredentialFence(nextState),
  };
}

export function applyOAuthRefresh(
  state: OAuthCredentialState,
  fence: OAuthCredentialFence,
  update: OAuthTokenUpdate,
): OAuthCredentialState | undefined {
  if (!isOAuthCredentialFenceCurrent(state, fence) || !state.tokens?.refreshToken) {
    return undefined;
  }
  assertTokenUpdate(update, "refresh");

  const refreshToken = update.refreshToken ?? state.tokens.refreshToken;
  return {
    ...cloneOAuthCredentialState(state),
    tokens: {
      accessToken: update.accessToken,
      accessTokenExpiresAt: update.accessTokenExpiresAt,
      refreshToken,
    },
    credentialRevision: incrementCounter(state.credentialRevision, "credentialRevision"),
  };
}

export function applyOAuthAuthorization(
  state: OAuthCredentialState,
  fence: OAuthCredentialFence,
  update: OAuthTokenUpdate,
): OAuthCredentialState | undefined {
  if (!isOAuthCredentialFenceCurrent(state, fence)) {
    return undefined;
  }
  assertTokenUpdate(update, "authorization");

  return {
    ...cloneOAuthCredentialState(state),
    credentialRevision: incrementCounter(state.credentialRevision, "credentialRevision"),
    tokens: {
      accessToken: update.accessToken,
      accessTokenExpiresAt: update.accessTokenExpiresAt,
      ...(update.refreshToken !== undefined ? { refreshToken: update.refreshToken } : {}),
    },
  };
}

export function clearOAuthTokens(
  state: OAuthCredentialState,
  expectedCredentialRevision?: number,
): OAuthTokenClearResult {
  if (expectedCredentialRevision !== undefined) {
    assertCounter(expectedCredentialRevision, "expectedCredentialRevision");
    if (state.credentialRevision !== expectedCredentialRevision) {
      return { state: cloneOAuthCredentialState(state), applied: false };
    }
  }

  return {
    applied: true,
    state: {
      credentialRevision: incrementCounter(state.credentialRevision, "credentialRevision"),
      authEpoch: incrementCounter(state.authEpoch, "authEpoch"),
    },
  };
}

function incrementCounter(value: number, fieldName: string): number {
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${fieldName} cannot be incremented safely.`);
  }
  return value + 1;
}

function assertTokenUpdate(update: OAuthTokenUpdate, operation: string): void {
  assertTokenCredentials(update, `${operation}Result`);
}
