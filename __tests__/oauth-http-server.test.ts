import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthAuthenticationError } from "../extensions/src/core/oauth/broker/authenticated-fetch.js";
import { OAuthBrokerClientError } from "../extensions/src/core/oauth/broker/client.js";
import type { ResolvedServerConfig, ServerDefinition } from "../extensions/src/core/modeling/types.js";
import { OauthHttpServer } from "../extensions/src/core/servers/servers/oauth-http-server.js";

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientListTools: vi.fn(),
  clientCallTool: vi.fn(),
  clientClose: vi.fn(),
  transportFetch: undefined as unknown,
  transportUrl: undefined as unknown,
}));

// OauthHttpServer 复用 SdkSessionManager；这里用假的 SDK Client/transport
// 隔离 OAuth 相关的状态与错误归一化行为，不重复测试 SDK 本身的请求逻辑。
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    onclose: (() => void) | undefined;

    async connect() {
      return await mocks.clientConnect();
    }

    async listTools() {
      return await mocks.clientListTools();
    }

    async callTool() {
      return await mocks.clientCallTool();
    }

    async close() {
      return await mocks.clientClose();
    }

    getServerVersion() {
      return { name: "mock", version: "0.0.1" };
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockTransport {
    constructor(url: URL, options: { fetch?: unknown }) {
      mocks.transportUrl = url;
      mocks.transportFetch = options.fetch;
    }

    async start() {}

    get sessionId() {
      return "session-1";
    }
  },
}));

const namespaceId = `agent-dir:v1:${"c".repeat(64)}`;

function makeConfig(definition: ServerDefinition = {}): ResolvedServerConfig {
  return {
    name: "remote",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: { name: "remote", content: "", source: "none" },
    definition: {
      transport: "http",
      url: "https://mcp.example.test/mcp",
      auth: "oauth",
      ...definition,
    },
  };
}

interface BrokerStub {
  readonly getOAuthStatus: ReturnType<typeof vi.fn>;
  readonly logoutOAuth: ReturnType<typeof vi.fn>;
  readonly authorizeOAuth: ReturnType<typeof vi.fn>;
  readonly getOAuthToken: ReturnType<typeof vi.fn>;
}

function makeBroker(overrides: Partial<BrokerStub> = {}): BrokerStub {
  return {
    getOAuthStatus: vi.fn(async () => ({ oauthState: "authorized", credentialRevision: 5 })),
    logoutOAuth: vi.fn(async () => ({
      oauthState: "authorization-required",
      credentialRevision: 6,
      applied: true,
    })),
    authorizeOAuth: vi.fn(async () => ({ oauthState: "authorized", credentialRevision: 7 })),
    getOAuthToken: vi.fn(async () => ({
      accessToken: "access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
      credentialRevision: 5,
    })),
    ...overrides,
  };
}

function makeServer(broker: BrokerStub, definition: ServerDefinition = {}, dependencies = true): OauthHttpServer {
  return new OauthHttpServer(
    makeConfig(definition),
    dependencies
      ? {
          oauthCapability: broker as never,
          namespaceId,
          probeTimeoutMs: 50,
        }
      : undefined,
  );
}

describe("OauthHttpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientConnect.mockResolvedValue(undefined);
    mocks.clientListTools.mockResolvedValue({ tools: [] });
    mocks.clientClose.mockResolvedValue(undefined);
  });

  it("broker 不可达时只为本次观测返回 unknown，不覆盖已知状态", async () => {
    const broker = makeBroker();
    const server = makeServer(broker);

    await expect(server.status()).resolves.toMatchObject({ oauthState: "authorized" });
    expect(server.snapshot()).toMatchObject({ oauthState: "authorized" });

    broker.getOAuthStatus.mockRejectedValueOnce(new OAuthBrokerClientError(
      "broker-unavailable",
      "broker is down",
    ));
    await expect(server.status()).resolves.toMatchObject({ oauthState: "unknown" });
    // unknown 是瞬时观测：缓存仍然是上一次成功读取的 authorized。
    expect(server.snapshot()).toMatchObject({ oauthState: "authorized" });
  });

  it("缺少 OAuth capability 时降为 unknown 并拒绝 OAuth 操作", async () => {
    const server = makeServer(makeBroker(), {}, false);

    expect(server.snapshot()).toMatchObject({ oauthState: "unknown" });
    await expect(server.status()).resolves.toMatchObject({ oauthState: "unknown" });
    await expect(server.authorize()).rejects.toThrow(/no OAuth broker is available/u);
    await expect(server.logout()).rejects.toThrow(/no OAuth broker is available/u);
  });

  it("认证失败按类别更新状态缓存", async () => {
    const broker = makeBroker();
    mocks.clientConnect.mockRejectedValueOnce(new OAuthAuthenticationError(
      "authorization-required",
      "MCP server \"remote\" requires OAuth authorization. Run mcp_server authorize to sign in.",
    ));
    const server = makeServer(broker);

    await expect(server.connect()).rejects.toMatchObject({ reason: "authorization-required" });
    expect(server.snapshot()).toMatchObject({ oauthState: "authorization-required" });

    // repair-failed 表示第二次鉴权拒绝，同样落在 authorization-required。
    mocks.clientConnect.mockRejectedValueOnce(new OAuthAuthenticationError(
      "repair-failed",
      "authentication failed again",
    ));
    await expect(server.connect()).rejects.toMatchObject({ reason: "repair-failed" });
    expect(server.snapshot()).toMatchObject({ oauthState: "authorization-required" });
  });

  it("临时认证失败不改变已知状态", async () => {
    const broker = makeBroker();
    const server = makeServer(broker);
    await server.status();
    expect(server.snapshot()).toMatchObject({ oauthState: "authorized" });

    mocks.clientConnect.mockRejectedValueOnce(new OAuthAuthenticationError(
      "resolution-failed",
      "token refresh failed temporarily",
    ));
    await expect(server.connect()).rejects.toMatchObject({ reason: "resolution-failed" });
    expect(server.snapshot()).toMatchObject({ oauthState: "authorized" });
  });

  it("logout 清凭证但保留 MCP 连接与 catalog", async () => {
    const broker = makeBroker();
    mocks.clientListTools.mockResolvedValue({
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    });
    const server = makeServer(broker);

    await server.connect();
    const catalogBefore = await server.getCatalog();
    expect(catalogBefore.tools.map(tool => tool.name)).toEqual(["echo"]);
    // transport 拿到了已认证的 fetch；真实的 token 注入与重放由端到端测试覆盖。
    expect(typeof mocks.transportFetch).toBe("function");

    await expect(server.logout()).resolves.toMatchObject({
      connectState: "connected",
      oauthState: "authorization-required",
    });
    expect(broker.logoutOAuth).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ resourceUrl: "https://mcp.example.test/mcp" }),
    }));
    // connection 生命周期与 credential 解耦：catalog 仍然可用。
    await expect(server.getCatalog()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: "echo" })],
    });
  });

  it("authorize 转发探测到的 PRM URL 与 scope，并在缺少参数时只发显式 scope", async () => {
    const broker = makeBroker();
    const server = makeServer(broker, { oauth: { scope: "read" } });

    mocks.transportFetch = undefined;
    await expect(server.authorize()).resolves.toMatchObject({ oauthState: "authorized" });
    // 探测请求失败（url 不可达）时静默回退：只带显式 scope。
    expect(broker.authorizeOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "read" }),
      expect.anything(),
    );
  });

  it("authorize 成功后不自动 connect", async () => {
    const broker = makeBroker();
    const server = makeServer(broker);

    await server.authorize();
    // 授权与连接生命周期完全解耦。
    expect(mocks.clientConnect).not.toHaveBeenCalled();
    expect(server.snapshot()).toMatchObject({
      connectState: "disconnected",
      oauthState: "authorized",
    });
  });

  it("close 关闭 MCP session 且从不关闭 borrowed broker client", async () => {
    const broker = makeBroker();
    mocks.clientListTools.mockResolvedValue({ tools: [] });
    const server = makeServer(broker);

    await server.connect();
    await server.close();
    expect(mocks.clientClose).toHaveBeenCalled();
    expect(server.snapshot()).toMatchObject({ connectState: "disconnected" });
    // broker client 由 root 拥有；server 不持有或关闭它。
    expect(broker).not.toHaveProperty("close");
  });
});
