import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthBrokerClient } from "../packages/core/src/oauth/broker/client.js";
import { runOAuthBrokerProcess } from "../packages/core/src/oauth/broker/broker-process.js";
import { FileOAuthCredentialRepository } from "../packages/core/src/oauth/broker/credential-repository.js";
import { createOAuthIdentity, type OAuthIdentity } from "../packages/core/src/oauth/broker/identity.js";
import { OauthHttpServer } from "../packages/core/src/servers/servers/oauth-http-server.js";
import type { ResolvedServerConfig } from "../packages/core/src/modeling/types.js";
import { FakeOAuthAuthorizationServer } from "./support/fake-oauth-as.js";
import { bearerTokenOf, startFakeMcpServer, type FakeMcpServer } from "./support/fake-mcp-server.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-session");
const namespaceId = `agent-dir:v1:${"a".repeat(64)}`;
const fakeAsServers: FakeOAuthAuthorizationServer[] = [];
const fakeMcpServers: FakeMcpServer[] = [];

afterEach(async () => {
  await Promise.all([
    ...fakeAsServers.splice(0).map(server => server.close()),
    ...fakeMcpServers.splice(0).map(server => server.close()),
  ]);
  tempDirs.cleanup();
});

async function startFakeAs(): Promise<FakeOAuthAuthorizationServer> {
  const server = await FakeOAuthAuthorizationServer.start();
  fakeAsServers.push(server);
  return server;
}

async function startFakeMcp(
  options: Parameters<typeof startFakeMcpServer>[0] = {},
): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer(options);
  fakeMcpServers.push(server);
  return server;
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  if (!port) {
    throw new Error("Expected the OS to allocate a loopback port.");
  }
  return port;
}

function makeConfig(url: string, oauth: { scope?: string } = {}): ResolvedServerConfig {
  return {
    name: "remote",
    connectionMode: "lazy",
    hasExplicitOverviewConfig: false,
    overview: { name: "remote", content: "", source: "none" },
    definition: {
      transport: "http",
      url,
      auth: "oauth",
      ...(oauth.scope === undefined ? {} : { oauth: { scope: oauth.scope } }),
    },
  };
}

interface Harness {
  readonly broker: OAuthBrokerClient;
  readonly running: Promise<void>;
  readonly server: OauthHttpServer;
  readonly identity: OAuthIdentity;
  readonly rootDir: string;
}

/**
 * 真实 broker + fake AS + fake MCP server 的完整 session 侧装配。
 * broker 的 authorize 用注入的 opener 完成，避免真的打开浏览器。
 */
async function startHarness(
  options: {
    readonly oauthScope?: string;
    /** 预置 broker 中的 credential；省略时第一次请求需要先 authorize。 */
    readonly preAuthorize?: boolean;
    readonly authorizeTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const rootDir = tempDirs.create();
  const as = await startFakeAs();
  const mcp = await startFakeMcp({ authorizationServers: [as.authorizationServerUrl] });
  const port = await allocatePort();

  const running = runOAuthBrokerProcess({
    rootDir,
    namespaceId,
    configuredPort: port,
    // idle 轮询间隔是 presenceTtlMs / 3，小 TTL 让 broker 退出更快；
    // pulse 是 100ms，1s 的 TTL 仍有足够余量。
    presenceTtlMs: 1_000,
    idleGraceMs: 200,
    lockStaleMs: 2_000,
    lockUpdateMs: 1_000,
    authorizeTimeoutMs: options.authorizeTimeoutMs ?? 5_000,
    openBrowser: async url => {
      const state = new URL(url).searchParams.get("state");
      if (!state) {
        throw new Error("Expected a state parameter.");
      }
      const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=test-code&state=${state}`);
      await response.text();
    },
  });
  const broker = new OAuthBrokerClient({
    rootDir,
    namespaceId,
    configuredPort: port,
    requestTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    reconnectIntervalMs: 20,
    presencePulseMs: 100,
    authorizeTimeoutMs: 10_000,
  });
  broker.start();
  await broker.ensureConnected();

  const identity = createOAuthIdentity({
    namespaceId,
    resourceUrl: mcp.url,
    profile: "default",
  });
  const server = new OauthHttpServer(makeConfig(mcp.url, {
    ...(options.oauthScope === undefined ? {} : { scope: options.oauthScope }),
  }), {
    oauthCapability: broker,
    namespaceId,
    probeTimeoutMs: 2_000,
  });

  if (options.preAuthorize !== false) {
    await server.authorize();
  }

  return { broker, running, server, identity, rootDir };
}

describe("OAuth session authenticated fetch", () => {
  it("connect 成功后注入 Bearer token 并发布 tools catalog", async () => {
    const harness = await startHarness();
    const mcp = fakeMcpServers.at(-1)!;

    try {
      const snapshot = await harness.server.connect();
      expect(snapshot.connectState).toBe("connected");
      expect(snapshot.tools?.map(tool => tool.name)).toEqual(["echo"]);

      const catalog = await harness.server.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      // 每个请求都走 broker 取 token，因此 initialize 与 tools/list 都带 Bearer。
      const authed = mcp.requests.filter(request => request.authorization !== undefined);
      expect(authed.length).toBeGreaterThanOrEqual(2);
      for (const request of authed) {
        expect(bearerTokenOf(request.authorization)).toBeTruthy();
      }
      expect(mcp.requests.some(request => request.method === "initialize")).toBe(true);
      expect(mcp.requests.some(request => request.method === "tools/list")).toBe(true);
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("未授权时给出 authorize 建议，不打开浏览器", async () => {
    const harness = await startHarness({ preAuthorize: false });

    try {
      await expect(harness.server.connect()).rejects.toMatchObject({
        code: "oauth-authentication-failed",
        reason: "authorization-required",
      });
      await expect(harness.server.connect()).rejects.toThrow(/mcp_server authorize/u);
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("401 后按 observed revision 修复 token 并最多重放一次", async () => {
    const harness = await startHarness();
    const mcp = fakeMcpServers.at(-1)!;

    try {
      await harness.server.connect();
      const before = mcp.requests.length;

      // 服务端先拒绝一次当前 token，修复后接受。
      mcp.enqueueAuthDecision({
        kind: "unauthorized",
        resourceMetadataUrl: `http://127.0.0.1:1/prm`,
      });
      const execution = await harness.server.callTool("echo", { text: "hi" });
      expect(execution.result.content).toHaveLength(1);

      const replayRequests = mcp.requests.slice(before);
      expect(replayRequests.map(request => request.method)).toEqual(["tools/call", "tools/call"]);
      // 修复会向 broker 换取新 token；fake AS 的默认 rotation 让两次 token 不同。
      expect(bearerTokenOf(replayRequests[0]!.authorization))
        .not.toBe(bearerTokenOf(replayRequests[1]!.authorization));
      expect(mcp.toolCalls).toHaveLength(1);
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("修复后第二次仍被拒时条件 logout 并停止重放", async () => {
    const harness = await startHarness();
    const mcp = fakeMcpServers.at(-1)!;

    try {
      await harness.server.connect();
      const before = mcp.requests.length;

      mcp.enqueueAuthDecision(
        { kind: "unauthorized" },
        { kind: "unauthorized" },
      );
      await expect(harness.server.callTool("echo", { text: "hi" })).rejects.toMatchObject({
        code: "oauth-authentication-failed",
        reason: "repair-failed",
      });

      // 每个原始请求最多两次：一次原始、一次修复重放。
      expect(mcp.requests.slice(before)).toHaveLength(2);
      expect(mcp.toolCalls).toHaveLength(0);

      const repository = await FileOAuthCredentialRepository.open(harness.rootDir, namespaceId);
      const record = await repository.readRecord(harness.identity);
      expect(record.authorization.tokens).toBeUndefined();
      expect(record.registration).toBeDefined();
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("insufficient_scope 追加 challenged scope 且不重放原请求", async () => {
    const harness = await startHarness();
    const mcp = fakeMcpServers.at(-1)!;

    try {
      await harness.server.connect();
      const before = mcp.requests.length;

      mcp.setAuthDecision({ kind: "accept" });
      mcp.enqueueAuthDecision({ kind: "insufficient-scope", scope: "admin" });

      await expect(harness.server.callTool("echo", { text: "hi" })).rejects.toMatchObject({
        code: "oauth-authentication-failed",
      });

      // 只发一次，不做 token 交换重放。
      expect(mcp.requests.slice(before)).toHaveLength(1);
      expect(mcp.toolCalls).toHaveLength(0);

      const repository = await FileOAuthCredentialRepository.open(harness.rootDir, namespaceId);
      const record = await repository.readRecord(harness.identity);
      expect(record.challengedScopes).toEqual(["admin"]);
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("重复的 challenged scope 报告无法授予且不清凭证", async () => {
    const harness = await startHarness();

    try {
      const before = await harness.broker.getOAuthStatus({ identity: harness.identity });
      const first = await harness.broker.challengeScope({
        identity: harness.identity,
        challengedScope: "admin",
        observedCredentialRevision: before.credentialRevision,
      });
      expect(first.outcome).toBe("appended-credential-cleared");
      expect(first.challengedScopes).toEqual(["admin"]);

      // 循环上界：同一 scope 再次被要求时既不追加也不清凭证，由调用方报告无法授予。
      await expect(harness.broker.challengeScope({
        identity: harness.identity,
        challengedScope: "admin",
        observedCredentialRevision: first.credentialRevision,
      })).rejects.toMatchObject({ remoteCode: "scope-not-grantable", status: 409 });

      const repository = await FileOAuthCredentialRepository.open(harness.rootDir, namespaceId);
      const record = await repository.readRecord(harness.identity);
      expect(record.challengedScopes).toEqual(["admin"]);
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("业务失败与 5xx 不触发 token 修复或重放", async () => {
    const harness = await startHarness();
    const mcp = fakeMcpServers.at(-1)!;

    try {
      await harness.server.connect();
      const before = mcp.requests.length;

      mcp.enqueueAuthDecision({ kind: "status", status: 503, body: "unavailable" });
      await expect(harness.server.callTool("echo", { text: "hi" })).rejects.toThrow();

      expect(mcp.requests.slice(before)).toHaveLength(1);
      expect(mcp.toolCalls).toHaveLength(0);

      const credentials = await harness.broker.getOAuthToken({
        identity: harness.identity,
        minRemainingMs: 0,
      });
      expect(credentials.accessToken).toBeTruthy();
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("显式 authorize 转发探测到的 PRM URL 与 scope，成功后不自动 connect", async () => {
    const harness = await startHarness({ preAuthorize: false });
    const mcp = fakeMcpServers.at(-1)!;

    try {
      const as = fakeAsServers.at(-1)!;
      const prmUrl = `${as.authorizationServerUrl}/.well-known/oauth-protected-resource/custom`;
      mcp.enqueueAuthDecision({
        kind: "unauthorized",
        scope: "read write",
        resourceMetadataUrl: prmUrl,
      });

      const snapshot = await harness.server.authorize();
      expect(snapshot).toMatchObject({ oauthState: "authorized", connectState: "disconnected" });

      // 探测请求是 initialize 且不带 token。
      const probe = mcp.requests.find(request => request.method === "initialize");
      expect(probe?.authorization).toBeUndefined();
      // broker 用转发的 PRM URL 作为 discovery 首选路径。
      expect(as.protectedResourceMetadataRequests.join("\n")).toContain("/custom");
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);

  it("探测失败时静默回退，authorize 仍然成功", async () => {
    const harness = await startHarness({ preAuthorize: false });
    const mcp = fakeMcpServers.at(-1)!;

    try {
      // 探测拿到 401 但没有 Bearer challenge；broker 回退 well-known discovery。
      mcp.setAuthDecision({ kind: "status", status: 401, body: "unauthorized" });
      await expect(harness.server.authorize()).resolves.toMatchObject({ oauthState: "authorized" });
      // 探测确实发生了：一次无 token 的 initialize 请求。
      expect(mcp.requests).toContainEqual({ method: "initialize" });
    } finally {
      await harness.server.close();
      await harness.broker.close();
      await harness.running;
    }
  }, 30_000);
});
