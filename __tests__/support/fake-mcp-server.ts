import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * 可编程鉴权的假 StreamableHTTP MCP server。
 *
 * 它只实现 OAuth 测试需要的最小 MCP 面（initialize / notifications/initialized /
 * tools/list / tools/call），并允许测试直接切换每个请求收到的鉴权判定，
 * 从而覆盖 token 注入、401 修复重放、403 step-up 与条件 logout。
 */

export interface FakeMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly handler?: (args: Record<string, unknown>) => unknown;
}

export type FakeMcpAuthDecision =
  | { readonly kind: "accept" }
  /** 带 Bearer challenge 的 401。 */
  | {
      readonly kind: "unauthorized";
      readonly scope?: string;
      readonly resourceMetadataUrl?: string;
    }
  /** 带 `error="insufficient_scope"` 的 403 step-up challenge。 */
  | { readonly kind: "insufficient-scope"; readonly scope: string; readonly status?: number }
  /** 结果未知的失败：不得触发 repair。 */
  | { readonly kind: "status"; readonly status: number; readonly body?: string };

export interface FakeMcpRequestRecord {
  readonly method: string;
  readonly authorization?: string;
  readonly sessionId?: string;
}

export interface FakeMcpServerOptions {
  readonly tools?: readonly FakeMcpTool[];
  readonly serverName?: string;
  /** 未调用 setAuthDecision 时的默认判定。 */
  readonly auth?: FakeMcpAuthDecision;
  /** 提供时，该 server 作为 PRM 的 resource server 指向这些 authorization server origin。 */
  readonly authorizationServers?: readonly string[];
  readonly scopesSupported?: readonly string[];
}

export interface FakeMcpCallRecord {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly authorization?: string;
}

export interface FakeMcpServer {
  readonly url: string;
  readonly origin: string;
  /** well-known PRM 的地址；未配置 authorizationServers 时仍可访问但 authorization_servers 为空。 */
  readonly protectedResourceMetadataUrl: string;
  /** 每次请求的原始记录，用于断言 token 注入与重放次数。 */
  readonly requests: readonly FakeMcpRequestRecord[];
  readonly toolCalls: readonly FakeMcpCallRecord[];
  /** initialize 被接受的次数；用于验证探测或连接建立。 */
  readonly initializeCount: () => number;
  setAuthDecision(decision: FakeMcpAuthDecision): void;
  /** 设置后依次消费，用尽后回落到当前默认判定。 */
  enqueueAuthDecision(...decisions: readonly FakeMcpAuthDecision[]): void;
  setTools(tools: readonly FakeMcpTool[]): void;
  close(): Promise<void>;
}

const BEARER_PREFIX = "Bearer ";

export async function startFakeMcpServer(options: FakeMcpServerOptions = {}): Promise<FakeMcpServer> {
  const requests: FakeMcpRequestRecord[] = [];
  const toolCalls: FakeMcpCallRecord[] = [];
  const queuedDecisions: FakeMcpAuthDecision[] = [];
  let defaultDecision: FakeMcpAuthDecision = options.auth ?? { kind: "accept" };
  let tools: readonly FakeMcpTool[] = options.tools ?? [
    { name: "echo", description: "Echo the provided text" },
  ];
  let initializeCount = 0;
  // 监听成功后才知道端口；PRM 响应需要它组成绝对 URL。
  let resourceUrl = "";

  const sessions = new Set<string>();
  const serverName = options.serverName ?? "fake-mcp";
  let sessionCounter = 0;

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    // PRM 是 OAuth discovery 的入口，与鉴权闸门无关，始终公开。
    if (requestUrl.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        resource: resourceUrl,
        authorization_servers: [...(options.authorizationServers ?? [])],
        scopes_supported: [...(options.scopesSupported ?? [])],
      }));
      return;
    }

    const body = await readBody(request);
    const method = typeof body?.method === "string" ? body.method : undefined;
    const authorization = firstHeader(request.headers.authorization);
    const sessionId = firstHeader(request.headers["mcp-session-id"]);
    if (method !== undefined) {
      requests.push({
        method,
        ...(authorization === undefined ? {} : { authorization }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }

    const decision = queuedDecisions.length > 0 ? queuedDecisions.shift()! : defaultDecision;

    if (decision.kind === "unauthorized") {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": buildBearerChallenge(decision),
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (decision.kind === "insufficient-scope") {
      response.writeHead(decision.status ?? 403, {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="insufficient_scope", scope="${decision.scope}"`,
      });
      response.end(JSON.stringify({ error: "insufficient_scope" }));
      return;
    }
    if (decision.kind === "status") {
      response.writeHead(decision.status, { "content-type": "application/json" });
      response.end(decision.body ?? JSON.stringify({ error: "failed" }));
      return;
    }

    // MCP 通知没有响应体；接受后直接结束。
    if (method === undefined || method.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }

    if (method === "initialize" || method === "tools/list" || method === "tools/call") {
      // 每次成功 initialize 分配一个新 session，更贴近真实 server 行为。
      if (method === "initialize") {
        sessionCounter += 1;
        sessions.add(`session-${sessionCounter}`);
        initializeCount += 1;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        ...(method === "initialize" ? { "mcp-session-id": `session-${sessionCounter}` } : {}),
      });
      response.end(JSON.stringify(buildResult(method, body, toolCalls, tools, authorization)));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: -32601, message: `Method not found: ${method}` },
    }));
  };

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind fake MCP server.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  resourceUrl = `${origin}/mcp`;

  return {
    origin,
    url: resourceUrl,
    protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    requests,
    toolCalls,
    initializeCount: () => initializeCount,
    setAuthDecision(decision) {
      defaultDecision = decision;
      queuedDecisions.length = 0;
    },
    enqueueAuthDecision(...decisions) {
      queuedDecisions.push(...decisions);
    },
    setTools(next) {
      tools = next;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function buildBearerChallenge(decision: Extract<FakeMcpAuthDecision, { kind: "unauthorized" }>): string {
  const parts = ["Bearer", 'error="invalid_token"'];
  if (decision.scope !== undefined) {
    parts.push(`scope="${decision.scope}"`);
  }
  if (decision.resourceMetadataUrl !== undefined) {
    parts.push(`resource_metadata="${decision.resourceMetadataUrl}"`);
  }
  return parts.join(", ").replace("Bearer, ", "Bearer ");
}

function buildResult(
  method: string,
  body: Record<string, unknown> | undefined,
  toolCalls: FakeMcpCallRecord[],
  tools: readonly FakeMcpTool[],
  authorization: string | undefined,
): unknown {
  const id = body?.id ?? null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.1", description: "Fake MCP server for OAuth tests" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map(tool => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: { type: "object", properties: {} },
        })),
      },
    };
  }

  const params = (body?.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const name = params.name ?? "";
  const args = params.arguments ?? {};
  toolCalls.push({
    name,
    arguments: args,
    ...(authorization === undefined ? {} : { authorization }),
  });
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const payload = tool.handler ? tool.handler(args) : { echoed: args };
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/** 提取注入的 Bearer token，便于断言 session 使用了正确的 token。 */
export function bearerTokenOf(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  return header.slice(BEARER_PREFIX.length);
}
