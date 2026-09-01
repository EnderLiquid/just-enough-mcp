import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OauthAuthorizationUrlOpener } from "./authorization-url-opener.js";
import { notifyInfo } from "../rendering/notifier.js";
import type { OauthCallbackRouter, OauthCallbackWaiter } from "./callback-router.js";
import { OauthCredentialStore, type OauthCredentialIdentity } from "./credential-store.js";
import { OauthAuthorizationRequiredError } from "./errors.js";

export interface McpOauthClientProviderOptions {
  serverName: string;
  identity: OauthCredentialIdentity;
  callbackRouter: OauthCallbackRouter;
  credentialStore: OauthCredentialStore;
  openAuthorizationUrl: OauthAuthorizationUrlOpener;
  clientMetadataUrl?: string;
  scope?: string;
  onCredentialsInvalidated?: () => void;
}

/**
 * 将 MCP SDK 的 OAuth hook 对接到插件的本地 credential file 和 session-owned
 * callback router。PKCE verifier 和 callback state 只保留在当前授权事务的内存中。
 */
export class McpOauthClientProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private interactiveAuthorization = false;
  private callbackWaiter: OauthCallbackWaiter | undefined;
  private verifier: string | undefined;

  constructor(private readonly options: McpOauthClientProviderOptions) {
    this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.options.callbackRouter.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "just-enough-mcp",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  async state(): Promise<string> {
    this.requireInteractiveAuthorization();
    this.callbackWaiter?.cancel();
    this.callbackWaiter = await this.options.callbackRouter.register();
    return this.callbackWaiter.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const clientInformation = (await this.options.credentialStore.read(this.options.identity))?.clientInformation;
    if (!clientInformation && !this.interactiveAuthorization) {
      throw new OauthAuthorizationRequiredError(this.options.serverName);
    }
    return clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.requireInteractiveAuthorization();
    await this.options.credentialStore.saveClientInformation(this.options.identity, clientInformation);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.options.credentialStore.read(this.options.identity))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.credentialStore.saveTokens(this.options.identity, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.requireInteractiveAuthorization();
    if (!this.callbackWaiter) {
      throw new Error("OAuth authorization callback state was not initialized.");
    }
    notifyInfo(`Opening OAuth authorization page for MCP server "${this.options.serverName}".`);
    await this.options.openAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("OAuth authorization code verifier is unavailable.");
    }
    return this.verifier;
  }

  beginInteractiveAuthorization(): void {
    this.interactiveAuthorization = true;
    this.callbackWaiter?.cancel();
    this.callbackWaiter = undefined;
    this.verifier = undefined;
  }

  async waitForAuthorizationCode(signal?: AbortSignal): Promise<string> {
    const callbackWaiter = this.callbackWaiter;
    if (!callbackWaiter) {
      throw new Error("OAuth authorization callback state was not initialized.");
    }

    try {
      return await callbackWaiter.wait(signal);
    } finally {
      if (this.callbackWaiter === callbackWaiter) {
        this.callbackWaiter = undefined;
      }
      this.interactiveAuthorization = false;
    }
  }

  cancelInteractiveAuthorization(): void {
    this.callbackWaiter?.cancel();
    this.callbackWaiter = undefined;
    this.verifier = undefined;
    this.interactiveAuthorization = false;
  }

  finishInteractiveAuthorization(): void {
    this.callbackWaiter?.cancel();
    this.callbackWaiter = undefined;
    this.verifier = undefined;
    this.interactiveAuthorization = false;
  }

  async clearAllCredentials(): Promise<void> {
    this.cancelInteractiveAuthorization();
    await this.options.credentialStore.clearAll(this.options.identity);
    this.options.onCredentialsInvalidated?.();
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    switch (scope) {
      case "all":
      case "client":
        await this.options.credentialStore.clearAll(this.options.identity);
        break;
      case "tokens":
        await this.options.credentialStore.clearTokens(this.options.identity);
        break;
      case "verifier":
        this.verifier = undefined;
        break;
      case "discovery":
        break;
      default: {
        const unreachable: never = scope;
        throw new Error(`Unsupported OAuth credential invalidation scope: ${String(unreachable)}`);
      }
    }

    this.options.onCredentialsInvalidated?.();
  }

  private requireInteractiveAuthorization(): void {
    if (!this.interactiveAuthorization) {
      throw new OauthAuthorizationRequiredError(this.options.serverName);
    }
  }
}
