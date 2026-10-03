import { randomBytes } from "node:crypto";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthIdentity } from "./identity.ts";
import type {
  OAuthAuthorizationUrlOperation,
  OAuthCodeExchangeOperation,
} from "./oauth-protocol-types.ts";
import {
  normalizeOAuthScope,
  type OAuthCredentialFence,
} from "./credential-state.ts";
import {
  OAuthClientRejectedError,
  OAuthPermanentRefreshError,
  OAuthTemporaryProtocolError,
  OAuthTokenCoordinator,
} from "./token-coordinator.ts";
import { DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_MS } from "./oauth-protocol.ts";
import type { BrowserOpener } from "./browser-opener.ts";

/** authorize 事务的失败原因；broker 路由层映射为 HTTP 状态与错误码。 */
export type OAuthAuthorizationErrorCode =
  | "authorization-denied"
  | "authorization-timeout"
  | "authorization-superseded"
  | "authorization-scope-rejected"
  | "authorization-code-rejected"
  | "authorization-client-rejected"
  | "browser-open-failed"
  | "temporary-protocol-error";

export class OAuthAuthorizationError extends Error {
  readonly code: OAuthAuthorizationErrorCode;

  constructor(code: OAuthAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "OAuthAuthorizationError";
    this.code = code;
  }
}

export interface OAuthAuthorizationRequest {
  readonly identity: OAuthIdentity;
  readonly scope?: string;
  readonly initialChallengeScope?: string;
  readonly resourceMetadataUrl?: string;
}

export interface OAuthAuthorizationResult {
  readonly oauthState: "authorized";
  readonly credentialRevision: number;
  readonly scope?: string;
}

/** callback 返回给浏览器的静态页面信息。 */
export interface OAuthCallbackPage {
  readonly status: number;
  readonly title: string;
  readonly message: string;
}

export interface OAuthCallbackParams {
  readonly state?: string;
  readonly code?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface OAuthAuthorizationTransactionsOptions {
  readonly coordinator: OAuthTokenCoordinator;
  readonly authorize: OAuthAuthorizationUrlOperation;
  readonly exchangeCode: OAuthCodeExchangeOperation;
  readonly redirectUri: string;
  /** 基础 DCR metadata，不含 client_name；后者在授权时从 identity 读取。 */
  readonly clientMetadata: OAuthClientMetadata;
  readonly openBrowser: BrowserOpener;
  readonly transactionTimeoutMs: number;
  readonly now?: () => number;
}

interface PendingTransaction {
  readonly identity: OAuthIdentity;
  readonly fence: OAuthCredentialFence;
  readonly state: string;
  readonly codeVerifier: string;
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadata?: AuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformationFull;
  readonly requestedScope?: string;
  readonly promise: Promise<OAuthAuthorizationResult>;
  readonly resolve: (result: OAuthAuthorizationResult) => void;
  readonly reject: (error: OAuthAuthorizationError) => void;
  settled: boolean;
  processing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * broker 内存内的一次性授权事务注册表。
 *
 * 同一 identity 的并发 authorize 共享同一个 pending promise；事务与 PKCE verifier
 * 都只存在于进程内存，broker 退出即作废。
 */
export class OAuthAuthorizationTransactions {
  private readonly coordinator: OAuthTokenCoordinator;
  private readonly authorizeOperation: OAuthAuthorizationUrlOperation;
  private readonly exchangeOperation: OAuthCodeExchangeOperation;
  private readonly redirectUri: string;
  private readonly clientMetadata: OAuthClientMetadata;
  private readonly openBrowser: BrowserOpener;
  private readonly transactionTimeoutMs: number;
  private readonly now: () => number;
  private readonly transactionsByState = new Map<string, PendingTransaction>();
  private readonly transactionsByIdentity = new Map<string, PendingTransaction>();
  private readonly startFlights = new Map<string, Promise<OAuthAuthorizationResult>>();

  constructor(options: OAuthAuthorizationTransactionsOptions) {
    this.coordinator = options.coordinator;
    this.authorizeOperation = options.authorize;
    this.exchangeOperation = options.exchangeCode;
    this.redirectUri = options.redirectUri;
    this.clientMetadata = options.clientMetadata;
    this.openBrowser = options.openBrowser;
    this.transactionTimeoutMs = options.transactionTimeoutMs;
    this.now = options.now ?? (() => Date.now());
  }

  get pendingCount(): number {
    return this.transactionsByIdentity.size;
  }

  hasPending(identity: OAuthIdentity): boolean {
    return this.transactionsByIdentity.has(identity.key);
  }

  /** 同一 identity 返回同一个共享等待；caller abort 只结束自己的等待。 */
  authorize(
    request: OAuthAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<OAuthAuthorizationResult> {
    const existing = this.transactionsByIdentity.get(request.identity.key)?.promise
      ?? this.startFlights.get(request.identity.key);
    if (existing) {
      return withCallerAbort(existing, signal);
    }
    const flight = this.startTransaction(request);
    this.startFlights.set(request.identity.key, flight);
    flight.then(
      () => this.clearStartFlight(request.identity.key, flight),
      () => this.clearStartFlight(request.identity.key, flight),
    );
    return withCallerAbort(flight, signal);
  }

  /** logout 或替换授权时终止 pending 事务。 */
  cancel(identity: OAuthIdentity): void {
    const transaction = this.transactionsByIdentity.get(identity.key);
    if (transaction) {
      this.settle(transaction, {
        error: new OAuthAuthorizationError(
          "authorization-superseded",
          "The OAuth authorization transaction was superseded by a newer credential operation.",
        ),
      });
    }
  }

  /** 终止所有事务；broker shutdown 时调用。 */
  cancelAll(): void {
    for (const transaction of [...this.transactionsByIdentity.values()]) {
      this.settle(transaction, {
        error: new OAuthAuthorizationError(
          "authorization-superseded",
          "The OAuth authorization transaction was cancelled because the broker is shutting down.",
        ),
      });
    }
  }

  /** 处理 `/oauth/callback` 查询参数；永远返回一个可渲染的静态页面。 */
  async handleCallback(params: OAuthCallbackParams): Promise<OAuthCallbackPage> {
    const state = params.state;
    if (!state) {
      return callbackNotFoundPage();
    }
    const transaction = this.transactionsByState.get(state);
    if (!transaction) {
      return callbackNotFoundPage();
    }
    if (transaction.processing) {
      return {
        status: 200,
        title: "Authorization in progress",
        message: "This authorization transaction is already being completed.",
      };
    }
    transaction.processing = true;
    this.stopTimer(transaction);

    if (params.error !== undefined) {
      if (params.error === "invalid_scope") {
        await this.coordinator.discardChallengedScopes(transaction.identity);
        this.settle(transaction, {
          error: new OAuthAuthorizationError(
            "authorization-scope-rejected",
            "The authorization server rejected the requested scope set.",
          ),
        });
      } else {
        this.settle(transaction, {
          error: new OAuthAuthorizationError(
            "authorization-denied",
            params.errorDescription?.trim()
              ? `Authorization was not granted: ${params.errorDescription.trim()}`
              : "Authorization was not granted by the user or the authorization server.",
          ),
        });
      }
      return callbackFailurePage("Authorization was not completed.");
    }

    const code = params.code;
    if (!code) {
      this.settle(transaction, {
        error: new OAuthAuthorizationError(
          "authorization-denied",
          "The authorization callback did not include an authorization code.",
        ),
      });
      return callbackFailurePage("The authorization callback was incomplete.");
    }

    try {
      const result = await this.exchangeAndCommit(transaction, code);
      this.settle(transaction, { result });
      return {
        status: 200,
        title: "Authorization complete",
        message: "You can close this window and return to Pi.",
      };
    } catch (error) {
      const failure = error instanceof OAuthAuthorizationError
        ? error
        : new OAuthAuthorizationError(
            "temporary-protocol-error",
            "The authorization code exchange failed.",
          );
      this.settle(transaction, { error: failure });
      return callbackFailurePage(failure.message);
    }
  }

  private async startTransaction(
    request: OAuthAuthorizationRequest,
  ): Promise<OAuthAuthorizationResult> {
    const identity = request.identity;
    let fence: OAuthCredentialFence | undefined;
    let transaction: PendingTransaction | undefined;
    try {
      fence = await this.coordinator.beginAuthorization(identity);
      const discovery = await this.coordinator.ensureDiscovery(identity, {
        force: true,
        ...(request.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: request.resourceMetadataUrl }),
      });
      const finalScope = await this.resolveScope(identity, request, discovery?.resourceMetadata
        ?.scopes_supported);
      const clientMetadata: OAuthClientMetadata = {
        ...this.clientMetadata,
        client_name: identity.clientName,
      };
      let registration = await this.coordinator.ensureRegistration(
        identity,
        clientMetadata,
        finalScope === undefined ? {} : { scope: finalScope },
      );
      if (discovery && registration.authorizationServerUrl !== discovery.authorizationServerUrl) {
        registration = await this.coordinator.ensureRegistration(identity, clientMetadata, {
          force: true,
          ...(finalScope === undefined ? {} : { scope: finalScope }),
        });
      }

      const state = randomBytes(32).toString("base64url");
      const authorizationUrl = await this.authorizeOperation({
        identity,
        authorizationServerUrl: registration.authorizationServerUrl,
        ...(discovery?.authorizationServerMetadata
          ? { authorizationServerMetadata: discovery.authorizationServerMetadata }
          : {}),
        clientInformation: registration.clientInformation,
        redirectUrl: this.redirectUri,
        state,
        ...(finalScope === undefined ? {} : { scope: finalScope }),
      });

      transaction = createPendingTransaction({
        identity,
        fence,
        state,
        codeVerifier: authorizationUrl.codeVerifier,
        authorizationServerUrl: registration.authorizationServerUrl,
        ...(discovery?.authorizationServerMetadata
          ? { authorizationServerMetadata: discovery.authorizationServerMetadata }
          : {}),
        clientInformation: registration.clientInformation,
        ...(finalScope === undefined ? {} : { requestedScope: finalScope }),
      });
      this.transactionsByState.set(state, transaction);
      this.transactionsByIdentity.set(identity.key, transaction);
      const pending = transaction;
      pending.timer = setTimeout(() => {
        this.settle(pending, {
          error: new OAuthAuthorizationError(
            "authorization-timeout",
            "The OAuth authorization transaction timed out before the browser redirected back.",
          ),
        });
      }, this.transactionTimeoutMs);
      pending.timer.unref?.();

      try {
        await this.openBrowser(authorizationUrl.authorizationUrl);
      } catch {
        throw new OAuthAuthorizationError(
          "browser-open-failed",
          "The OAuth authorization URL could not be opened in a browser.",
        );
      }
    } catch (error) {
      const failure = normalizeStartError(error);
      if (failure.code === "authorization-client-rejected" && fence !== undefined) {
        await this.coordinator.clearClientAuthorization(identity, fence).catch(() => undefined);
      }
      if (transaction) {
        this.settle(transaction, { error: failure });
      } else {
        throw failure;
      }
    }

    return await transaction.promise;
  }

  private async exchangeAndCommit(
    transaction: PendingTransaction,
    code: string,
  ): Promise<OAuthAuthorizationResult> {
    let tokens: OAuthTokens;
    try {
      tokens = await this.exchangeOperation({
        identity: transaction.identity,
        authorizationServerUrl: transaction.authorizationServerUrl,
        ...(transaction.authorizationServerMetadata
          ? { authorizationServerMetadata: transaction.authorizationServerMetadata }
          : {}),
        clientInformation: transaction.clientInformation,
        code,
        codeVerifier: transaction.codeVerifier,
        redirectUrl: this.redirectUri,
        resource: new URL(transaction.identity.resourceUrl),
      });
    } catch (error) {
      throw await this.classifyExchangeFailure(transaction, error);
    }

    if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
      throw new OAuthAuthorizationError(
        "temporary-protocol-error",
        "The authorization server returned no access token.",
      );
    }
    const expiresInMs = typeof tokens.expires_in === "number"
      && Number.isFinite(tokens.expires_in)
      && tokens.expires_in > 0
      ? tokens.expires_in * 1_000
      : DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_MS;
    const committed = await this.coordinator.commitAuthorization(
      transaction.identity,
      transaction.fence,
      {
        accessToken: tokens.access_token,
        accessTokenExpiresAt: this.now() + expiresInMs,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...(tokens.scope !== undefined
          ? { scope: tokens.scope }
          : transaction.requestedScope === undefined
            ? {}
            : { scope: transaction.requestedScope }),
      },
    );
    if (committed === undefined) {
      throw new OAuthAuthorizationError(
        "authorization-superseded",
        "The OAuth authorization transaction was superseded before it could commit.",
      );
    }

    return {
      oauthState: "authorized",
      credentialRevision: committed,
      ...(tokens.scope === undefined
        ? transaction.requestedScope === undefined
          ? {}
          : { scope: transaction.requestedScope }
        : { scope: normalizeOAuthScope(tokens.scope) }),
    };
  }

  private async classifyExchangeFailure(
    transaction: PendingTransaction,
    error: unknown,
  ): Promise<OAuthAuthorizationError> {
    if (error instanceof OAuthPermanentRefreshError) {
      if (error.reason === "invalid-scope") {
        await this.coordinator.discardChallengedScopes(transaction.identity);
        return new OAuthAuthorizationError(
          "authorization-scope-rejected",
          "The authorization server rejected the requested scope set.",
        );
      }
      return new OAuthAuthorizationError(
        "authorization-code-rejected",
        "The authorization code was rejected or is no longer valid; retry authorization.",
      );
    }
    if (error instanceof OAuthClientRejectedError) {
      await this.coordinator.clearClientAuthorization(transaction.identity, transaction.fence);
      return new OAuthAuthorizationError(
        "authorization-client-rejected",
        "The authorization server rejected this OAuth client registration.",
      );
    }
    if (error instanceof OAuthTemporaryProtocolError) {
      return new OAuthAuthorizationError(
        "temporary-protocol-error",
        "The authorization code exchange failed temporarily; retry authorization.",
      );
    }
    return new OAuthAuthorizationError(
      "temporary-protocol-error",
      "The authorization code exchange failed without a conclusive result.",
    );
  }

  private async resolveScope(
    identity: OAuthIdentity,
    request: OAuthAuthorizationRequest,
    scopesSupported: readonly string[] | undefined,
  ): Promise<string | undefined> {
    const challenged = await this.coordinator.getChallengedScopes(identity);
    const base = request.scope ?? request.initialChallengeScope ?? scopesSupported?.join(" ");
    try {
      const merged = [...(base ? normalizeOAuthScope(base).split(" ") : []), ...challenged];
      return merged.length === 0 ? undefined : normalizeOAuthScope(merged.join(" "));
    } catch (error) {
      throw new OAuthAuthorizationError(
        "temporary-protocol-error",
        `OAuth scope metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private clearStartFlight(identityKey: string, flight: Promise<OAuthAuthorizationResult>): void {
    if (this.startFlights.get(identityKey) === flight) {
      this.startFlights.delete(identityKey);
    }
  }

  private settle(
    transaction: PendingTransaction,
    outcome: { result: OAuthAuthorizationResult } | { error: OAuthAuthorizationError },
  ): void {
    if (transaction.settled) {
      return;
    }
    transaction.settled = true;
    this.stopTimer(transaction);
    if (this.transactionsByState.get(transaction.state) === transaction) {
      this.transactionsByState.delete(transaction.state);
    }
    if (this.transactionsByIdentity.get(transaction.identity.key) === transaction) {
      this.transactionsByIdentity.delete(transaction.identity.key);
    }
    if ("result" in outcome) {
      transaction.resolve(outcome.result);
    } else {
      transaction.reject(outcome.error);
    }
  }

  private stopTimer(transaction: PendingTransaction): void {
    if (transaction.timer) {
      clearTimeout(transaction.timer);
      transaction.timer = undefined;
    }
  }
}

function createPendingTransaction(init: {
  identity: OAuthIdentity;
  fence: OAuthCredentialFence;
  state: string;
  codeVerifier: string;
  authorizationServerUrl: string;
  authorizationServerMetadata?: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationFull;
  requestedScope?: string;
}): PendingTransaction {
  let resolve!: (result: OAuthAuthorizationResult) => void;
  let reject!: (error: OAuthAuthorizationError) => void;
  const promise = new Promise<OAuthAuthorizationResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    ...init,
    promise,
    resolve,
    reject,
    settled: false,
    processing: false,
    timer: undefined,
  };
}

function normalizeStartError(error: unknown): OAuthAuthorizationError {
  if (error instanceof OAuthAuthorizationError) {
    return error;
  }
  if (error instanceof OAuthClientRejectedError) {
    return new OAuthAuthorizationError(
      "authorization-client-rejected",
      "The authorization server rejected this OAuth client registration.",
    );
  }
  if (error instanceof OAuthPermanentRefreshError) {
    return new OAuthAuthorizationError(
      "temporary-protocol-error",
      "The authorization server rejected the authorization request.",
    );
  }
  return new OAuthAuthorizationError(
    "temporary-protocol-error",
    "OAuth discovery or client registration failed temporarily.",
  );
}

function callbackNotFoundPage(): OAuthCallbackPage {
  return {
    status: 400,
    title: "Authorization transaction not found",
    message: "This authorization transaction is no longer active. Return to Pi and start authorization again.",
  };
}

function callbackFailurePage(message: string): OAuthCallbackPage {
  return {
    status: 200,
    title: "Authorization failed",
    message,
  };
}

function withCallerAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }
  return new Promise<T>((resolveAbort, rejectAbort) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectAbort(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveAbort(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectAbort(error);
      },
    );
  });
}

function createAbortError(cause: unknown): Error {
  const error = new Error("OAuth authorization wait was aborted by the caller.");
  error.name = "AbortError";
  return Object.assign(error, { cause });
}
