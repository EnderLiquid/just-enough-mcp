import { openAuthorizationUrl, type OauthAuthorizationUrlOpener } from "./authorization-url-opener.js";
import { OauthCallbackRouter } from "./callback-router.js";
import { OauthCredentialStore } from "./credential-store.js";

export interface OauthSessionServices {
  readonly credentialStore: OauthCredentialStore;
  readonly callbackRouter: OauthCallbackRouter;
  readonly openAuthorizationUrl: OauthAuthorizationUrlOpener;
  close(): Promise<void>;
}

export interface CreateOauthSessionServicesOptions {
  credentialFilePath: string;
  callbackUrl?: string;
  openAuthorizationUrl?: OauthAuthorizationUrlOpener;
}

/** 由 session 拥有、供 OAuth HTTP server 共享的依赖。 */
export function createOauthSessionServices(
  options: CreateOauthSessionServicesOptions,
): OauthSessionServices {
  const callbackRouter = new OauthCallbackRouter(options.callbackUrl);
  return {
    credentialStore: new OauthCredentialStore(options.credentialFilePath),
    callbackRouter,
    openAuthorizationUrl: options.openAuthorizationUrl ?? openAuthorizationUrl,
    close: () => callbackRouter.close(),
  };
}
