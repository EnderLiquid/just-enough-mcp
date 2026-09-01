import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ResolvedServerConfig,
  ServerConnectState,
  ServerOauthState,
} from "../../modeling/types.js";
import { AsyncReadWriteLock } from "../../concurrency/async-read-write-lock.js";
import { notifyServerDescriptionReady } from "../../config/overview-bootstrapper.js";
import { McpOauthClientProvider } from "../../oauth/mcp-oauth-client-provider.js";
import type { OauthSessionServices } from "../../oauth/session-services.js";
import { OauthAuthorizationRequiredError } from "../../oauth/errors.js";
import {
  applyToolNameFilter,
  createToolNameFilter,
  isToolNameFilteredByConfig,
  type ToolNameFilter,
} from "./tool-filter.js";

export interface OauthSdkSessionOptions {
  serverName: string;
  config: ResolvedServerConfig;
  serverUrl: URL;
  requestHeaders?: Record<string, string>;
  clientMetadataUrl?: string;
  scope?: string;
  services: OauthSessionServices;
}

export interface OauthSdkSessionSnapshot {
  connectState: ServerConnectState;
  oauthState: ServerOauthState;
  tools?: Tool[];
  description?: string;
}

export interface OauthSdkSessionToolCatalogResult {
  snapshot: OauthSdkSessionSnapshot;
  tools: Tool[];
}

export interface OauthSdkSessionToolCallResult {
  snapshot: OauthSdkSessionSnapshot;
  result: CallToolResult;
}

function createBaseClient(serverName: string): Client {
  return new Client({ name: `just-enough-mcp-${serverName}`, version: "0.1.0" });
}

function authorizationInProgressError(serverName: string): Error {
  return new Error(`OAuth authorization is already in progress for MCP server "${serverName}".`);
}

/**
 * 管理单个 HTTP MCP server 的 OAuth 专用生命周期。它不复用普通 SDK manager
 * 的自动连接假设：只有 authorize() 可以打开浏览器并等待 callback。
 */
export class OauthSdkSessionManager {
  private client: Client | undefined;
  private remoteTools: Tool[] | undefined;
  private publishedState: OauthSdkSessionSnapshot = {
    connectState: "disconnected",
    oauthState: "authorization-required",
  };
  private readonly lifecycleLock = new AsyncReadWriteLock();
  private readonly toolFilter: ToolNameFilter;
  private readonly provider: McpOauthClientProvider;
  private authorizingPromise: Promise<OauthSdkSessionSnapshot> | undefined;
  private authorizationGeneration = 0;

  constructor(private readonly options: OauthSdkSessionOptions) {
    this.toolFilter = createToolNameFilter(options.config);
    this.provider = new McpOauthClientProvider({
      serverName: options.serverName,
      identity: {
        serverName: options.serverName,
        serverUrl: options.serverUrl.toString(),
        ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
      },
      callbackRouter: options.services.callbackRouter,
      credentialStore: options.services.credentialStore,
      openAuthorizationUrl: options.services.openAuthorizationUrl,
      ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      onCredentialsInvalidated: () => this.publishOauthState("authorization-required"),
    });
  }

  async connect(signal?: AbortSignal): Promise<OauthSdkSessionSnapshot> {
    if (this.authorizingPromise) {
      throw authorizationInProgressError(this.options.serverName);
    }

    const connectedSnapshot = await this.lifecycleLock.withRead(() =>
      this.client ? this.snapshot() : undefined,
    );
    if (connectedSnapshot) {
      return connectedSnapshot;
    }

    return this.lifecycleLock.withWrite(async () => {
      if (this.authorizingPromise) {
        throw authorizationInProgressError(this.options.serverName);
      }
      await this.connectLocked(signal);
      return this.snapshot();
    });
  }

  async authorize(signal?: AbortSignal): Promise<OauthSdkSessionSnapshot> {
    if (this.authorizingPromise) {
      return this.authorizingPromise;
    }

    const promise = this.authorizeInternal(signal);
    this.authorizingPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.authorizingPromise === promise) {
        this.authorizingPromise = undefined;
      }
    }
  }

  async getTools(signal?: AbortSignal): Promise<OauthSdkSessionToolCatalogResult> {
    return this.withConnectedRead(signal, () => {
      const tools = this.visibleTools() ?? [];
      return {
        snapshot: this.snapshot(),
        tools,
      };
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OauthSdkSessionToolCallResult> {
    return this.withConnectedRead(signal, async () => {
      this.requireAvailableTool(name);
      try {
        const result = await this.client!.callTool(
          {
            name,
            arguments: args,
          },
          undefined,
          signal ? { signal } : undefined,
        ) as CallToolResult;
        return {
          snapshot: this.snapshot(),
          result,
        };
      } catch (error) {
        throw this.normalizeOAuthError(error);
      }
    });
  }

  async close(): Promise<OauthSdkSessionSnapshot> {
    await this.cancelAuthorization();
    return this.lifecycleLock.withWrite(() => this.closeLocked());
  }

  async logout(): Promise<OauthSdkSessionSnapshot> {
    await this.cancelAuthorization();
    return this.lifecycleLock.withWrite(async () => {
      await this.closeLocked();
      await this.provider.clearAllCredentials();
      this.publishOauthState("authorization-required");
      return this.snapshot();
    });
  }

  snapshot(): OauthSdkSessionSnapshot {
    return {
      ...this.publishedState,
      tools: this.publishedState.tools ? [...this.publishedState.tools] : undefined,
    };
  }

  private async authorizeInternal(signal?: AbortSignal): Promise<OauthSdkSessionSnapshot> {
    const generation = this.authorizationGeneration;
    await this.lifecycleLock.withWrite(() => {
      this.provider.beginInteractiveAuthorization();
      this.publishOauthState("authorizing");
    });

    try {
      const firstResult = await auth(this.provider, {
        serverUrl: this.options.serverUrl,
        ...(this.options.scope ? { scope: this.options.scope } : {}),
      });
      this.assertAuthorizationStillActive(generation);

      if (firstResult === "REDIRECT") {
        const code = await this.provider.waitForAuthorizationCode(signal);
        this.assertAuthorizationStillActive(generation);
        await auth(this.provider, {
          serverUrl: this.options.serverUrl,
          authorizationCode: code,
          ...(this.options.scope ? { scope: this.options.scope } : {}),
        });
        this.assertAuthorizationStillActive(generation);
      }

      this.provider.finishInteractiveAuthorization();
      return this.lifecycleLock.withWrite(async () => {
        this.assertAuthorizationStillActive(generation);
        await this.connectLocked(signal);
        this.publishOauthState("authorized");
        return this.snapshot();
      });
    } catch (error) {
      this.provider.cancelInteractiveAuthorization();
      await this.lifecycleLock.withWrite(() => {
        if (generation === this.authorizationGeneration) {
          this.publishOauthState("authorization-required");
        }
      });
      throw this.normalizeOAuthError(error);
    }
  }

  private async withConnectedRead<T>(
    signal: AbortSignal | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (this.authorizingPromise) {
      throw authorizationInProgressError(this.options.serverName);
    }

    const initial = await this.lifecycleLock.withRead(async () => {
      if (!this.client) {
        return { connected: false } as const;
      }

      return {
        connected: true,
        value: await operation(),
      } as const;
    });

    if (initial.connected) {
      return initial.value;
    }

    await this.lifecycleLock.withWrite(async () => {
      if (this.authorizingPromise) {
        throw authorizationInProgressError(this.options.serverName);
      }
      await this.connectLocked(signal);
    });

    return this.lifecycleLock.withRead(async () => {
      if (!this.client) {
        throw new Error(
          `MCP server "${this.options.serverName}" became unavailable before the requested operation could start.`,
        );
      }

      return operation();
    });
  }

  private async connectLocked(signal?: AbortSignal): Promise<void> {
    if (this.client) {
      return;
    }

    this.publishConnectState("connecting");

    let client: Client | undefined;
    let closedBeforePublish = false;
    try {
      client = createBaseClient(this.options.serverName);
      const candidate = client;
      client.onclose = () => {
        closedBeforePublish = true;
        this.enqueueClientInvalidation(candidate);
      };
      const requestOptions = signal ? { signal } : undefined;
      await client.connect(this.createTransport(), requestOptions);
      const listed = await client.listTools(undefined, requestOptions);
      if (closedBeforePublish) {
        throw new Error(`MCP client for server "${this.options.serverName}" closed during initialization.`);
      }

      this.client = client;
      this.remoteTools = listed.tools ?? [];
      const description = client.getServerVersion()?.description;
      this.publishedState = {
        connectState: "connected",
        oauthState: "authorized",
        tools: this.visibleTools() ?? [],
        ...(description ? { description } : {}),
      };
      if (typeof description === "string" && description.trim().length > 0) {
        notifyServerDescriptionReady({
          config: this.options.config,
          description,
        });
      }
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
      }
      this.remoteTools = undefined;
      this.publishConnectState("disconnected");
      await client?.close().catch(() => {});
      throw this.normalizeOAuthError(error);
    }
  }

  private createTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.options.serverUrl), {
      authProvider: this.provider,
      ...(this.options.requestHeaders ? { requestInit: { headers: this.options.requestHeaders } } : {}),
    });
  }

  private async closeLocked(): Promise<OauthSdkSessionSnapshot> {
    const client = this.client;
    if (!client) {
      this.remoteTools = undefined;
      this.publishConnectState("disconnected");
      return this.snapshot();
    }

    this.client = undefined;
    this.remoteTools = undefined;
    this.publishConnectState("disconnecting");

    await client.close().catch(() => {});
    this.publishConnectState("disconnected");
    return this.snapshot();
  }

  private enqueueClientInvalidation(client: Client): void {
    void this.lifecycleLock
      .withWrite(() => this.invalidateClientLocked(client))
      .catch(() => {});
  }

  private invalidateClientLocked(client: Client): void {
    if (this.client !== client) {
      return;
    }

    this.client = undefined;
    this.remoteTools = undefined;
    this.publishConnectState("disconnected");
  }

  private publishConnectState(connectState: ServerConnectState): void {
    this.publishedState = {
      connectState,
      oauthState: this.publishedState.oauthState,
      ...(this.publishedState.description ? { description: this.publishedState.description } : {}),
    };
  }

  private publishOauthState(oauthState: ServerOauthState): void {
    this.publishedState = {
      ...this.publishedState,
      oauthState,
      tools: this.publishedState.tools ? [...this.publishedState.tools] : undefined,
    };
  }

  private visibleTools(): Tool[] | undefined {
    if (!this.remoteTools) {
      return undefined;
    }
    return applyToolNameFilter(this.remoteTools, this.toolFilter);
  }

  private requireAvailableTool(toolName: string): void {
    if (this.visibleTools()?.some(tool => tool.name === toolName)) {
      return;
    }

    if (this.remoteTools?.some(tool => tool.name === toolName) && isToolNameFilteredByConfig(toolName, this.toolFilter)) {
      throw new Error(`Tool "${toolName}" is excluded by configuration on MCP server "${this.options.serverName}".`);
    }

    throw new Error(`Tool "${toolName}" is not available on MCP server "${this.options.serverName}".`);
  }

  private async cancelAuthorization(): Promise<void> {
    this.authorizationGeneration += 1;
    this.provider.cancelInteractiveAuthorization();
    const authorizing = this.authorizingPromise;
    if (authorizing) {
      await authorizing.catch(() => undefined);
    }
  }

  private assertAuthorizationStillActive(generation: number): void {
    if (generation !== this.authorizationGeneration) {
      throw new Error("OAuth authorization was cancelled.");
    }
  }

  private normalizeOAuthError(error: unknown): Error {
    if (error instanceof OauthAuthorizationRequiredError) {
      this.publishOauthState("authorization-required");
      return error;
    }
    if (error instanceof UnauthorizedError) {
      this.publishOauthState("authorization-required");
      return new OauthAuthorizationRequiredError(this.options.serverName);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
