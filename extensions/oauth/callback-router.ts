import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const DEFAULT_OAUTH_CALLBACK_URL = "http://127.0.0.1:33418/oauth/callback";

export interface OauthCallbackWaiter {
  readonly state: string;
  wait(signal?: AbortSignal): Promise<string>;
  cancel(): void;
}

interface PendingCallback {
  resolve(code: string): void;
  reject(error: Error): void;
}

function createAbortError(): Error {
  return new Error("OAuth authorization was cancelled.");
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>OAuth authorization</title></head><body><p>${body}</p></body></html>`);
}

function validateRedirectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OAuth callback URL must be a valid URL: ${value}`);
  }

  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || !url.pathname
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("OAuth callback URL must be an http://127.0.0.1:<port>/<path> URL without query, fragment, or credentials.");
  }

  return url;
}

/**
 * 在一个 Pi session 中为所有 server 路由 OAuth authorization-code callback。
 * listener 按需启动，但 redirect URI 保持稳定，以兼容 DCR 和用户提供的
 * Client ID Metadata Document。
 */
export class OauthCallbackRouter {
  readonly redirectUrl: string;
  private readonly parsedRedirectUrl: URL;
  private readonly pending = new Map<string, PendingCallback>();
  private server: Server | undefined;
  private listenPromise: Promise<void> | undefined;
  private closed = false;

  constructor(redirectUrl = DEFAULT_OAUTH_CALLBACK_URL) {
    this.parsedRedirectUrl = validateRedirectUrl(redirectUrl);
    this.redirectUrl = this.parsedRedirectUrl.toString();
  }

  async register(): Promise<OauthCallbackWaiter> {
    if (this.closed) {
      throw new Error("OAuth callback router is closed.");
    }

    await this.ensureListening();
    let state: string;
    do {
      state = randomBytes(32).toString("base64url");
    } while (this.pending.has(state));

    let settled = false;
    let resolveCallback!: (code: string) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => {
      resolveCallback = code => {
        if (settled) return;
        settled = true;
        this.pending.delete(state);
        resolve(code);
      };
      rejectCallback = error => {
        if (settled) return;
        settled = true;
        this.pending.delete(state);
        reject(error);
      };
    });
    void callback.catch(() => {});
    this.pending.set(state, { resolve: resolveCallback, reject: rejectCallback });

    return {
      state,
      wait: signal => this.waitForCallback(callback, signal, rejectCallback),
      cancel: () => rejectCallback(createAbortError()),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const closingError = new Error("OAuth callback router was closed.");
    for (const callback of this.pending.values()) {
      callback.reject(closingError);
    }
    this.pending.clear();

    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }).catch(error => {
      if (isNodeError(error, "ERR_SERVER_NOT_RUNNING")) {
        return;
      }
      throw error;
    });
  }

  private async ensureListening(): Promise<void> {
    if (this.listenPromise) {
      return this.listenPromise;
    }

    const server = createServer((request, response) => this.handleRequest(request, response));
    server.on("error", () => {});
    this.server = server;
    const port = Number(this.parsedRedirectUrl.port);
    const host = this.parsedRedirectUrl.hostname;
    this.listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        this.listenPromise = undefined;
        reject(new Error(`Could not listen for the OAuth callback at ${this.redirectUrl}: ${error.message}`));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port });
    });
    return this.listenPromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
      response.end();
      return;
    }

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url ?? "/", this.parsedRedirectUrl);
    } catch {
      writeHtml(response, 400, "Invalid OAuth callback request.");
      return;
    }

    if (callbackUrl.pathname !== this.parsedRedirectUrl.pathname) {
      writeHtml(response, 404, "OAuth callback path not found.");
      return;
    }

    const state = callbackUrl.searchParams.get("state");
    if (!state) {
      writeHtml(response, 400, "OAuth callback is missing state.");
      return;
    }

    const pending = this.pending.get(state);
    if (!pending) {
      writeHtml(response, 400, "OAuth callback state is invalid or has already been used.");
      return;
    }

    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) {
      pending.reject(new Error(`OAuth authorization failed: ${oauthError}.`));
      writeHtml(response, 400, "OAuth authorization was not completed. You may close this page.");
      return;
    }

    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      pending.reject(new Error("OAuth callback is missing an authorization code."));
      writeHtml(response, 400, "OAuth callback is missing an authorization code.");
      return;
    }

    pending.resolve(code);
    writeHtml(response, 200, "OAuth authorization completed. You may close this page.");
  }

  private waitForCallback(
    callback: Promise<string>,
    signal: AbortSignal | undefined,
    cancel: (error: Error) => void,
  ): Promise<string> {
    if (!signal) {
      return callback;
    }
    if (signal.aborted) {
      cancel(createAbortError());
      return callback;
    }

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        cancel(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void callback.then(
        code => {
          signal.removeEventListener("abort", onAbort);
          resolve(code);
        },
        error => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
