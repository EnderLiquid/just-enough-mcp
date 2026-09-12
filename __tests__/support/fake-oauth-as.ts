import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** token endpoint 收到的请求参数。 */
export interface FakeOAuthTokenRequestRecord {
  readonly grantType: string;
  readonly refreshToken?: string;
  readonly clientId?: string;
  readonly resource?: string;
  readonly scope?: string;
}

/** 单次 token endpoint 响应脚本；未入队时使用默认的 rotation 行为。 */
export type FakeOAuthTokenOutcome =
  | {
      readonly kind: "tokens";
      readonly accessToken?: string;
      readonly refreshToken?: string | null;
      readonly scope?: string;
      readonly expiresIn?: number;
    }
  | {
      readonly kind: "oauth-error";
      readonly error: string;
      readonly description?: string;
      readonly status?: number;
    }
  | { readonly kind: "status"; readonly status: number; readonly body?: string }
  /** 直接断开连接，模拟网络错误。 */
  | { readonly kind: "network-error" }
  /** 保持响应 pending，用于 timeout 测试；close() 会强制结束。 */
  | { readonly kind: "hang" };

export type FakeOAuthRegistrationOutcome =
  | { readonly kind: "client"; readonly clientId?: string }
  | {
      readonly kind: "oauth-error";
      readonly error: string;
      readonly description?: string;
      readonly status?: number;
    }
  | { readonly kind: "status"; readonly status: number };

export interface FakeOAuthAuthorizationServerOptions {
  readonly scopesSupported?: readonly string[];
  readonly clientId?: string;
  readonly rotateRefreshTokens?: boolean;
  readonly accessTokenLifetimeSeconds?: number;
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
}

export interface FakeHttpResponse {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * 测试用最小 OAuth Authorization Server：
 * PRM、AS metadata、DCR 与 token endpoint；行为可通过入队 outcome 覆盖。
 */
export class FakeOAuthAuthorizationServer {
  private readonly server: Server;
  private readonly options: Required<
    Pick<
      FakeOAuthAuthorizationServerOptions,
      | "scopesSupported"
      | "clientId"
      | "rotateRefreshTokens"
      | "accessTokenLifetimeSeconds"
      | "tokenEndpointAuthMethodsSupported"
    >
  >;
  private readonly tokenOutcomes: FakeOAuthTokenOutcome[] = [];
  private readonly registrationOutcomes: FakeOAuthRegistrationOutcome[] = [];
  private readonly hangingResponses = new Set<ServerResponse>();
  private readonly recordedTokenRequests: FakeOAuthTokenRequestRecord[] = [];
  private readonly recordedRegistrationRequests: Record<string, unknown>[] = [];
  private tokenCounter = 0;
  private protectedResourceMetadataResponse: FakeHttpResponse | undefined;
  private authorizationServerMetadataResponse: FakeHttpResponse | undefined;
  private origin = "";
  private listening = false;

  private constructor(options: FakeOAuthAuthorizationServerOptions, server: Server) {
    this.options = {
      scopesSupported: options.scopesSupported ?? ["read", "write"],
      clientId: options.clientId ?? "fake-client",
      rotateRefreshTokens: options.rotateRefreshTokens ?? true,
      accessTokenLifetimeSeconds: options.accessTokenLifetimeSeconds ?? 3_600,
      tokenEndpointAuthMethodsSupported: options.tokenEndpointAuthMethodsSupported ?? ["none"],
    };
    this.server = server;
    this.server.on("request", (request, response) => {
      void this.handleRequest(request, response);
    });
  }

  static async start(
    options: FakeOAuthAuthorizationServerOptions = {},
  ): Promise<FakeOAuthAuthorizationServer> {
    const instance = new FakeOAuthAuthorizationServer(options, createServer());
    await instance.listen();
    return instance;
  }

  get authorizationServerUrl(): string {
    return this.origin;
  }

  get resourceUrl(): string {
    return `${this.origin}/mcp`;
  }

  get protectedResourceMetadataUrl(): string {
    return `${this.origin}/.well-known/oauth-protected-resource/mcp`;
  }

  get tokenEndpoint(): string {
    return `${this.origin}/token`;
  }

  get registrationEndpoint(): string {
    return `${this.origin}/register`;
  }

  get tokenRequests(): readonly FakeOAuthTokenRequestRecord[] {
    return [...this.recordedTokenRequests];
  }

  get registrationRequests(): readonly Record<string, unknown>[] {
    return [...this.recordedRegistrationRequests];
  }

  enqueueTokenOutcome(outcome: FakeOAuthTokenOutcome): void {
    this.tokenOutcomes.push(outcome);
  }

  enqueueRegistrationOutcome(outcome: FakeOAuthRegistrationOutcome): void {
    this.registrationOutcomes.push(outcome);
  }

  /** undefined 恢复默认 PRM；status 404 模拟不支持 protected resource metadata。 */
  setProtectedResourceMetadataResponse(response: FakeHttpResponse | undefined): void {
    this.protectedResourceMetadataResponse = response;
  }

  setAuthorizationServerMetadataResponse(response: FakeHttpResponse | undefined): void {
    this.authorizationServerMetadataResponse = response;
  }

  async close(): Promise<void> {
    for (const response of this.hangingResponses) {
      response.destroy();
    }
    this.hangingResponses.clear();
    if (!this.listening) {
      return;
    }
    await new Promise<void>(resolveClose => {
      this.server.close(() => resolveClose());
    });
    this.server.closeAllConnections?.();
    this.listening = false;
  }

  private listen(): Promise<void> {
    return new Promise((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        const port = typeof address === "object" && address ? address.port : undefined;
        if (!port) {
          reject(new Error("Fake OAuth AS did not receive a loopback port."));
          return;
        }
        this.origin = `http://127.0.0.1:${port}`;
        this.listening = true;
        resolveListen();
      });
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (request.method === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource")) {
      this.sendConfiguredResponse(
        response,
        this.protectedResourceMetadataResponse,
        this.defaultProtectedResourceMetadata(),
      );
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/.well-known/oauth-authorization-server")) {
      this.sendConfiguredResponse(
        response,
        this.authorizationServerMetadataResponse,
        this.defaultAuthorizationServerMetadata(),
      );
      return;
    }

    if (request.method === "POST" && pathname === "/register") {
      await this.handleRegistration(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/token") {
      await this.handleToken(request, response);
      return;
    }

    sendText(response, 404, "not found");
  }

  private async handleRegistration(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch {
      sendText(response, 400, "invalid client metadata");
      return;
    }
    this.recordedRegistrationRequests.push(metadata);

    const outcome = this.registrationOutcomes.shift() ?? { kind: "client" as const };
    if (outcome.kind === "oauth-error") {
      sendJson(response, outcome.status ?? 400, {
        error: outcome.error,
        ...(outcome.description ? { error_description: outcome.description } : {}),
      });
      return;
    }
    if (outcome.kind === "status") {
      sendText(response, outcome.status, "registration failed");
      return;
    }
    sendJson(response, 201, {
      client_id: outcome.clientId ?? this.options.clientId,
      ...metadata,
    });
  }

  private async handleToken(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const params = new URLSearchParams(await readBody(request));
    const refreshToken = params.get("refresh_token");
    const clientId = params.get("client_id");
    const resource = params.get("resource");
    const scope = params.get("scope");
    this.recordedTokenRequests.push({
      grantType: params.get("grant_type") ?? "",
      ...(refreshToken === null ? {} : { refreshToken }),
      ...(clientId === null ? {} : { clientId }),
      ...(resource === null ? {} : { resource }),
      ...(scope === null ? {} : { scope }),
    });

    const outcome = this.tokenOutcomes.shift() ?? { kind: "tokens" as const };
    if (outcome.kind === "oauth-error") {
      sendJson(response, outcome.status ?? 400, {
        error: outcome.error,
        ...(outcome.description ? { error_description: outcome.description } : {}),
      });
      return;
    }
    if (outcome.kind === "status") {
      sendText(response, outcome.status, outcome.body ?? "token endpoint failed");
      return;
    }
    if (outcome.kind === "network-error") {
      response.socket?.destroy();
      return;
    }
    if (outcome.kind === "hang") {
      this.hangingResponses.add(response);
      return;
    }

    const counter = ++this.tokenCounter;
    const rotatedRefreshToken = refreshToken ?? `refresh-${counter}`;
    sendJson(response, 200, {
      access_token: outcome.accessToken ?? `access-${counter}`,
      token_type: "Bearer",
      expires_in: outcome.expiresIn ?? this.options.accessTokenLifetimeSeconds,
      scope: outcome.scope ?? scope ?? this.options.scopesSupported.join(" "),
      ...(outcome.refreshToken === null
        ? {}
        : {
            refresh_token: outcome.refreshToken
              ?? (this.options.rotateRefreshTokens ? `refresh-${counter}` : rotatedRefreshToken),
          }),
    });
  }

  private sendConfiguredResponse(
    response: ServerResponse,
    configured: FakeHttpResponse | undefined,
    fallback: Record<string, unknown>,
  ): void {
    if (configured === undefined) {
      sendJson(response, 200, fallback);
      return;
    }
    if (configured.body === undefined) {
      sendText(response, configured.status, "");
      return;
    }
    sendJson(response, configured.status, configured.body);
  }

  private defaultProtectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.origin],
      scopes_supported: [...this.options.scopesSupported],
    };
  }

  private defaultAuthorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: this.tokenEndpoint,
      registration_endpoint: this.registrationEndpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [...this.options.tokenEndpointAuthMethodsSupported],
      code_challenge_methods_supported: ["S256"],
    };
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}
