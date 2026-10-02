import { describe, expect, it, vi } from "vitest";
import { createOAuthIdentity, type OAuthIdentity } from "../packages/core/src/oauth/broker/identity.js";
import {
  createOAuthCredentialState,
  type OAuthCredentialState,
  type OAuthTokenUpdate,
} from "../packages/core/src/oauth/broker/credential-state.js";
import {
  createOAuthCredentialRecord,
  type OAuthClientRegistration,
  type OAuthCredentialRecord,
} from "../packages/core/src/oauth/broker/credential-record.js";
import {
  OAuthAuthorizationRequiredError,
  OAuthClientRejectedError,
  OAuthCredentialChangedError,
  OAuthPermanentRefreshError,
  OAuthScopeNotGrantedError,
  OAuthTemporaryProtocolError,
  OAuthTokenCoordinator,
  type OAuthRefreshOperation,
  type OAuthRefreshRequest,
} from "../packages/core/src/oauth/broker/token-coordinator.js";
import { InMemoryOAuthCredentialRepository } from "../packages/core/src/oauth/broker/credential-repository.js";

function makeIdentity(name = "demo"): OAuthIdentity {
  return createOAuthIdentity({
    namespaceId: "agent-dir-a",
    resourceUrl: `https://example.com/${name}`,
    profile: "default",
  });
}

function makeState(
  accessToken = "access-old",
  accessTokenExpiresAt = 0,
  refreshToken = "refresh-old",
  credentialRevision = 1,
  authEpoch = 0,
) {
  return createOAuthCredentialState({
    credentialRevision,
    authEpoch,
    tokens: {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
    },
  });
}

function makeRegistration(): OAuthClientRegistration {
  return {
    strategy: "dcr",
    authorizationServerUrl: "https://as.example.test/",
    clientInformation: {
      client_id: "client-1",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    },
  };
}

function makeRecord(authorization: OAuthCredentialState): OAuthCredentialRecord {
  return createOAuthCredentialRecord({
    authorization,
    registration: makeRegistration(),
  });
}

function makeDiscoveryResult(authorizationServerUrl = "https://as.example.test") {
  return {
    authorizationServerUrl,
    authorizationServerMetadata: {
      issuer: authorizationServerUrl,
      authorization_endpoint: `${authorizationServerUrl}/authorize`,
      token_endpoint: `${authorizationServerUrl}/token`,
      response_types_supported: ["code"],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeCoordinator(
  refresh: OAuthRefreshOperation,
  now = 1_000,
): OAuthTokenCoordinator {
  // 这些用例针对状态机语义；safety window 由专门的用例覆盖。
  return new OAuthTokenCoordinator({
    refresh,
    now: () => now,
    tokenSafetyWindowMs: 0,
  });
}

describe("OAuth credential 状态", () => {
  it("返回不含 refresh token 的 token snapshot", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(
      identity,
      makeRecord(makeState("access-current", 2_000, "refresh-secret", 7, 2)),
    );

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-current",
      accessTokenExpiresAt: 2_000,
      credentialRevision: 7,
    });
    expect(await coordinator.getCredentialView(identity)).toEqual({
      credentialRevision: 7,
      authEpoch: 2,
      hasAccessToken: true,
      accessTokenExpiresAt: 2_000,
      hasRefreshToken: true,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("并发 token acquisition 共享同一个 refresh single-flight 和已提交 revision", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async request => {
      expect(request.refreshToken).toBe("refresh-old");
      expect(request.credentialRevision).toBe(4);
      expect(request.authEpoch).toBe(3);
      return gate.promise;
    });
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 4, 3)));

    const first = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    const second = coordinator.getAccessToken(makeIdentity(), { minRemainingMs: 100 });
    const third = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    gate.resolve({
      accessToken: "access-new",
      accessTokenExpiresAt: 5_000,
      refreshToken: "refresh-rotated",
    });
    const snapshots = await Promise.all([first, second, third]);

    expect(snapshots).toEqual([
      {
        accessToken: "access-new",
        accessTokenExpiresAt: 5_000,
        credentialRevision: 5,
      },
      {
        accessToken: "access-new",
        accessTokenExpiresAt: 5_000,
        credentialRevision: 5,
      },
      {
        accessToken: "access-new",
        accessTokenExpiresAt: 5_000,
        credentialRevision: 5,
      },
    ]);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 5,
      authEpoch: 3,
      hasRefreshToken: true,
    });

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual(
      snapshots[0],
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refresh callback 重入 token acquisition 时仍只启动一次 refresh", async () => {
    const identity = makeIdentity();
    let nested: Promise<unknown> | undefined;
    let coordinator!: OAuthTokenCoordinator;
    const refresh = vi.fn<OAuthRefreshOperation>(async () => {
      nested = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
      return {
        accessToken: "access-new",
        accessTokenExpiresAt: 5_000,
      };
    });
    coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 1, 0)));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: 5_000,
      credentialRevision: 2,
    });
    expect(nested).toBeDefined();
    await expect(nested).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: 5_000,
      credentialRevision: 2,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("server 拒绝当前 revision 时，即使 token 未过期也会修复一次", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "access-repaired",
      accessTokenExpiresAt: 4_000,
    }));
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-rejected", 4_000, "refresh-old", 8, 1)));

    await expect(coordinator.getAccessToken(identity, {
      minRemainingMs: 100,
      rejectedCredentialRevision: 8,
    })).resolves.toEqual({
      accessToken: "access-repaired",
      accessTokenExpiresAt: 4_000,
      credentialRevision: 9,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("观察到较旧 revision 时直接使用 broker 已提交的较新 token", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "should-not-run",
      accessTokenExpiresAt: 4_000,
    }));
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-new", 4_000, "refresh-new", 9, 1)));

    await expect(coordinator.getAccessToken(identity, {
      minRemainingMs: 100,
      rejectedCredentialRevision: 8,
    })).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: 4_000,
      credentialRevision: 9,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("没有 refresh token 时返回 authorization-required，而不是隐式授权", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "should-not-run",
      accessTokenExpiresAt: 4_000,
    }));
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(createOAuthCredentialState({
      credentialRevision: 2,
      authEpoch: 1,
      tokens: {
        accessToken: "access-old",
        accessTokenExpiresAt: 0,
      },
    })));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 }))
      .rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("临时 refresh 错误不修改 credential，并允许下一次调用重试", async () => {
    const identity = makeIdentity();
    const failure = new Error("temporary token endpoint failure");
    const refresh = vi.fn<OAuthRefreshOperation>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        accessToken: "access-retried",
        accessTokenExpiresAt: 4_000,
      });
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 3, 2)));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).rejects.toBe(failure);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 3,
      authEpoch: 2,
      hasAccessToken: true,
    });

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-retried",
      accessTokenExpiresAt: 4_000,
      credentialRevision: 4,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refresh token rotation 未返回新 refresh token 时保留旧值", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>()
      .mockResolvedValueOnce({
        accessToken: "access-new",
        accessTokenExpiresAt: 4_000,
      })
      .mockResolvedValueOnce({
        accessToken: "access-newer",
        accessTokenExpiresAt: 8_000,
      });
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-keep", 3, 2)));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: 4_000,
      credentialRevision: 4,
    });
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 4,
      hasRefreshToken: true,
    });

    await expect(coordinator.getAccessToken(identity, {
      now: 5_000,
      minRemainingMs: 100,
    })).resolves.toEqual({
      accessToken: "access-newer",
      accessTokenExpiresAt: 8_000,
      credentialRevision: 5,
    });
    expect(refresh).toHaveBeenNthCalledWith(2, expect.objectContaining({
      refreshToken: "refresh-keep",
      credentialRevision: 4,
      authEpoch: 2,
    }));
  });

  it("永久 refresh 拒绝只清除当前 revision，并要求重新授权", async () => {
    const identity = makeIdentity();
    const coordinator = makeCoordinator(async () => {
      throw new OAuthPermanentRefreshError("invalid_grant");
    });
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 4, 2)));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 }))
      .rejects.toBeInstanceOf(OAuthAuthorizationRequiredError);
    expect(await coordinator.getCredentialView(identity)).toEqual({
      credentialRevision: 5,
      authEpoch: 3,
      hasAccessToken: false,
      hasRefreshToken: false,
    });
  });

  it("迟到的永久 refresh 拒绝不能把新授权描述为 authorization-required", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => gate.promise);
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 4, 2)));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const fence = await coordinator.beginAuthorization(identity);
    expect(await coordinator.commitAuthorization(identity, fence, {
      accessToken: "access-new",
      accessTokenExpiresAt: 8_000,
      refreshToken: "refresh-new",
    })).toBe(5);
    gate.reject(new OAuthPermanentRefreshError("stale invalid_grant"));

    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialChangedError);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 5,
      authEpoch: 3,
      hasAccessToken: true,
      hasRefreshToken: true,
      accessTokenExpiresAt: 8_000,
    });
  });

  it("条件 logout 的 revision 不匹配时不清除更新后的 credential", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-new", 4_000, "refresh-new", 9, 2)));

    expect(await coordinator.logout(identity, 8)).toEqual({
      applied: false,
      reason: "revision-superseded",
      credential: {
        credentialRevision: 9,
        authEpoch: 2,
        hasAccessToken: true,
        accessTokenExpiresAt: 4_000,
        hasRefreshToken: true,
      },
    });
    expect((await coordinator.getCredentialView(identity)).hasAccessToken).toBe(true);

    expect(await coordinator.logout(identity, 9)).toEqual({
      applied: true,
      credential: {
        credentialRevision: 10,
        authEpoch: 3,
        hasAccessToken: false,
        hasRefreshToken: false,
      },
    });
  });

  it("旧 revision 的条件 logout 不能清除已经提交的新 refresh 结果", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "access-new",
      accessTokenExpiresAt: 5_000,
      refreshToken: "refresh-new",
    }));
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 4, 1)));

    await coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    expect(await coordinator.logout(identity, 4)).toMatchObject({ applied: false });
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 5,
      authEpoch: 1,
      hasAccessToken: true,
      hasRefreshToken: true,
    });
  });

  it("条件 logout 在 refresh 在途时拒绝；显式 logout 不等待 refresh 且迟到结果被 fence 丢弃", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => gate.promise);
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 6, 4)));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await coordinator.logout(identity, 6)).toMatchObject({
      applied: false,
      reason: "refresh-in-flight",
    });
    expect(await coordinator.logout(identity)).toMatchObject({ applied: true });

    gate.resolve({
      accessToken: "access-stale",
      accessTokenExpiresAt: 9_000,
      refreshToken: "refresh-stale",
    });
    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialChangedError);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 7,
      authEpoch: 5,
      hasAccessToken: false,
      hasRefreshToken: false,
    });
    await expect(coordinator.getAccessToken(identity)).rejects.toBeInstanceOf(
      OAuthAuthorizationRequiredError,
    );
  });

  it("开始新 authorization 时递增 authEpoch，并阻止旧 refresh 或旧 commit", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => gate.promise);
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 2, 5)));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const fence = await coordinator.beginAuthorization(identity);
    expect(fence).toEqual({ credentialRevision: 2, authEpoch: 6 });
    expect(await coordinator.commitAuthorization(identity, fence, {
      accessToken: "access-authorized",
      accessTokenExpiresAt: 8_000,
      refreshToken: "refresh-authorized",
    })).toBe(3);

    gate.resolve({ accessToken: "access-stale", accessTokenExpiresAt: 9_000 });
    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialChangedError);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 3,
      authEpoch: 6,
      hasAccessToken: true,
      accessTokenExpiresAt: 8_000,
      hasRefreshToken: true,
    });
  });

  it("旧 authorization fence 不能提交到更新后的授权生命周期", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 4_000, "refresh-old", 2, 5)));

    const oldFence = await coordinator.beginAuthorization(identity);
    const newFence = await coordinator.beginAuthorization(identity);
    expect(await coordinator.commitAuthorization(identity, oldFence, {
      accessToken: "access-stale",
      accessTokenExpiresAt: 6_000,
      refreshToken: "refresh-stale",
    })).toBeUndefined();
    expect(await coordinator.commitAuthorization(identity, newFence, {
      accessToken: "access-current",
      accessTokenExpiresAt: 7_000,
      refreshToken: "refresh-current",
    })).toBe(3);
    expect(await coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 3,
      authEpoch: 7,
      accessTokenExpiresAt: 7_000,
    });
  });

  it("默认 safety window 要求 token 至少剩余 30 秒", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "access-refreshed",
      accessTokenExpiresAt: 1_000 + 3_600_000,
    }));
    const coordinator = new OAuthTokenCoordinator({ refresh, now: () => 1_000 });

    await coordinator.restore(
      identity,
      makeRecord(makeState("access-near", 1_000 + 31_000, "refresh-old", 1, 0)),
    );
    await expect(coordinator.getAccessToken(identity)).resolves.toMatchObject({
      accessToken: "access-near",
      credentialRevision: 1,
    });
    expect(refresh).not.toHaveBeenCalled();

    await coordinator.restore(
      identity,
      makeRecord(makeState("access-near", 1_000 + 29_000, "refresh-old", 1, 0)),
    );
    await expect(coordinator.getAccessToken(identity)).resolves.toMatchObject({
      accessToken: "access-refreshed",
      credentialRevision: 2,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("请求 scope 超出已存授权时直接失败，绝不发起扩张型 refresh", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(createOAuthCredentialState({
      credentialRevision: 3,
      authEpoch: 0,
      tokens: {
        accessToken: "access-current",
        accessTokenExpiresAt: 50_000,
        refreshToken: "refresh-old",
        scope: "read",
      },
    })));

    await expect(coordinator.getAccessToken(identity, { scope: "read write" }))
      .rejects.toBeInstanceOf(OAuthScopeNotGrantedError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refresh 返回的 scope 收窄时返回 scope-not-granted", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => ({
      accessToken: "access-refreshed",
      accessTokenExpiresAt: 60_000,
      refreshToken: "refresh-new",
      scope: "read",
    }));
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(createOAuthCredentialState({
      credentialRevision: 3,
      authEpoch: 0,
      tokens: {
        accessToken: "access-old",
        accessTokenExpiresAt: 0,
        refreshToken: "refresh-old",
        scope: "read write",
      },
    })));

    await expect(coordinator.getAccessToken(identity, { scope: "read write" }))
      .rejects.toBeInstanceOf(OAuthScopeNotGrantedError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("discovery 在 TTL 内复用缓存，过期后刷新，失败时沿用缓存", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    let now = 1_000_000;
    const discover = vi.fn(async () => makeDiscoveryResult());
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new Error("unused"); },
      discover,
      now: () => now,
      discoveryTtlMs: 86_400_000,
    });

    await expect(coordinator.ensureDiscovery(identity)).resolves.toMatchObject({ fetchedAt: 1_000_000 });
    expect(discover).toHaveBeenCalledTimes(1);
    await expect(coordinator.ensureDiscovery(identity)).resolves.toMatchObject({ fetchedAt: 1_000_000 });
    expect(discover).toHaveBeenCalledTimes(1);

    now += 86_400_001;
    discover.mockRejectedValueOnce(new OAuthTemporaryProtocolError("discovery down"));
    await expect(coordinator.ensureDiscovery(identity)).resolves.toMatchObject({ fetchedAt: 1_000_000 });

    discover.mockResolvedValueOnce(makeDiscoveryResult());
    await expect(coordinator.ensureDiscovery(identity)).resolves.toMatchObject({ fetchedAt: now });
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("无缓存时 discovery 失败按临时协议错误上抛，并发只发起一次", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    let rejectDiscovery!: (error: unknown) => void;
    const discover = vi.fn(() => new Promise<never>((_resolve, rejectPromise) => {
      rejectDiscovery = rejectPromise;
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new Error("unused"); },
      discover,
      now: () => 1_000,
    });

    const first = coordinator.ensureDiscovery(identity);
    const second = coordinator.ensureDiscovery(identity);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    rejectDiscovery(new OAuthTemporaryProtocolError("discovery down"));
    await expect(first).rejects.toBeInstanceOf(OAuthTemporaryProtocolError);
    await expect(second).rejects.toBeInstanceOf(OAuthTemporaryProtocolError);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("DCR 按 identity single-flight，并同时保存 discovery 与 registration", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    const discover = vi.fn(async () => makeDiscoveryResult());
    const register = vi.fn(async () => ({
      client_id: "client-1",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new Error("unused"); },
      discover,
      register,
      now: () => 1_000,
    });
    const clientMetadata = {
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    };

    const [first, second] = await Promise.all([
      coordinator.ensureRegistration(identity, clientMetadata),
      coordinator.ensureRegistration(identity, clientMetadata),
    ]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      strategy: "dcr",
      authorizationServerUrl: "https://as.example.test",
      clientInformation: { client_id: "client-1" },
    });
    const record = await repository.readRecord(identity);
    expect(record.registration).toEqual(first);
    expect(record.discovery).toMatchObject({ fetchedAt: 1_000 });
  });

  it("refresh 请求携带 registration 与匹配的 AS metadata", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    const requests: OAuthRefreshRequest[] = [];
    const refresh = vi.fn<OAuthRefreshOperation>(async request => {
      requests.push(request);
      return {
        accessToken: "access-refreshed",
        accessTokenExpiresAt: 60_000,
        refreshToken: "refresh-new",
      };
    });
    const clientInformation = {
      client_id: "client-1",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    };
    const registration = {
      strategy: "dcr" as const,
      authorizationServerUrl: "https://as.example.test",
      clientInformation,
    };
    const metadata = makeDiscoveryResult().authorizationServerMetadata;
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 1, 0),
        registration,
        discovery: {
          authorizationServerUrl: "https://as.example.test",
          fetchedAt: 1_000,
          authorizationServerMetadata: metadata,
        },
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh,
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await coordinator.getAccessToken(identity);
    expect(requests[0]?.registration).toEqual(registration);
    expect(requests[0]?.authorizationServerMetadata).toEqual(metadata);
  });

  it("discovery 的 AS URL 与 registration 不一致时 refresh 省略 metadata", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    const requests: OAuthRefreshRequest[] = [];
    const refresh = vi.fn<OAuthRefreshOperation>(async request => {
      requests.push(request);
      return { accessToken: "access-refreshed", accessTokenExpiresAt: 60_000 };
    });
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 1, 0),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        discovery: {
          authorizationServerUrl: "https://other-as.example.test",
          fetchedAt: 1_000,
        },
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh,
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await coordinator.getAccessToken(identity);
    expect(requests[0]?.registration).toBeDefined();
    expect(requests[0]?.authorizationServerMetadata).toBeUndefined();
  });

  it("invalid_client 清除 token、registration 与追加 scope，保留 discovery", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 2, 1),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        discovery: { authorizationServerUrl: "https://as.example.test", fetchedAt: 1_000 },
        challengedScopes: ["write"],
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new OAuthClientRejectedError("invalid_client"); },
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await expect(coordinator.getAccessToken(identity)).rejects.toMatchObject({
      code: "authorization-required",
      reason: "client-rejected",
    });
    const record = await repository.readRecord(identity);
    expect(record.authorization).toEqual(createOAuthCredentialState({
      credentialRevision: 3,
      authEpoch: 2,
    }));
    expect(record.registration).toBeUndefined();
    expect(record.challengedScopes).toEqual([]);
    expect(record.discovery).toMatchObject({ fetchedAt: 1_000 });
  });

  it("invalid_grant 只清 token，保留 registration、discovery 与追加 scope", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 2, 1),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        challengedScopes: ["write"],
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new OAuthPermanentRefreshError("invalid_grant"); },
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await expect(coordinator.getAccessToken(identity)).rejects.toMatchObject({
      code: "authorization-required",
      reason: "credential-rejected",
    });
    const record = await repository.readRecord(identity);
    expect(record.authorization.tokens).toBeUndefined();
    expect(record.registration).toBeDefined();
    expect(record.challengedScopes).toEqual(["write"]);
  });

  it("token endpoint 的 invalid_scope 清 token 与追加 scope，保留 registration 与 discovery", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 2, 1),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        discovery: { authorizationServerUrl: "https://as.example.test", fetchedAt: 1_000 },
        challengedScopes: ["write"],
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => {
        throw new OAuthPermanentRefreshError("invalid_scope", { reason: "invalid-scope" });
      },
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await expect(coordinator.getAccessToken(identity)).rejects.toMatchObject({
      code: "authorization-required",
      reason: "credential-rejected",
    });
    const record = await repository.readRecord(identity);
    expect(record.authorization.tokens).toBeUndefined();
    expect(record.registration).toBeDefined();
    expect(record.discovery).toMatchObject({ fetchedAt: 1_000 });
    expect(record.challengedScopes).toEqual([]);
  });

  it("临时协议错误保留全部 credential 与 client 状态", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 2, 1),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
      },
      result: undefined,
    }));
    const failure = new OAuthTemporaryProtocolError("token endpoint down");
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw failure; },
      now: () => 1_000,
      tokenSafetyWindowMs: 0,
    });

    await expect(coordinator.getAccessToken(identity)).rejects.toBe(failure);
    const record = await repository.readRecord(identity);
    expect(record.authorization).toEqual(makeState("access-old", 0, "refresh-old", 2, 1));
    expect(record.registration).toBeDefined();
  });

  it("revision 不匹配优先于 refresh 在途返回 revision-superseded", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => gate.promise);
    const coordinator = makeCoordinator(refresh);
    await coordinator.restore(identity, makeRecord(makeState("access-old", 0, "refresh-old", 5, 1)));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await coordinator.logout(identity, 4)).toMatchObject({
      applied: false,
      reason: "revision-superseded",
    });

    gate.resolve({ accessToken: "access-new", accessTokenExpiresAt: 9_000 });
    await pending;
  });

  it("commitAuthorization 成功提交时清空追加 scope 集合", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        registration: makeRegistration(),
        challengedScopes: ["admin"],
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({ refresh: vi.fn<OAuthRefreshOperation>(), repository });
    const fence = await coordinator.beginAuthorization(identity);

    expect(await coordinator.commitAuthorization(identity, fence, {
      accessToken: "access-authorized",
      accessTokenExpiresAt: 60_000,
      refreshToken: "refresh-authorized",
    })).toBe(1);
    const record = await repository.readRecord(identity);
    expect(record.challengedScopes).toEqual([]);
    expect(record.authorization.tokens?.accessToken).toBe("access-authorized");
  });

  it("clearClientAuthorization 按 fence 清 token、registration 与追加 scope", async () => {
    const identity = makeIdentity();
    const repository = new InMemoryOAuthCredentialRepository();
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: makeState("access-old", 0, "refresh-old", 2, 1),
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        challengedScopes: ["admin"],
      },
      result: undefined,
    }));
    const coordinator = new OAuthTokenCoordinator({ refresh: vi.fn<OAuthRefreshOperation>(), repository });
    const fence = { credentialRevision: 2, authEpoch: 1 };

    expect(await coordinator.clearClientAuthorization(identity, fence)).toBe(true);
    const record = await repository.readRecord(identity);
    expect(record.registration).toBeUndefined();
    expect(record.challengedScopes).toEqual([]);
    expect(record.authorization.tokens).toBeUndefined();
    expect(await coordinator.clearClientAuthorization(identity, fence)).toBe(false);
  });

  it("ensureDiscovery 把转发的 resource metadata URL 传给 discovery 操作", async () => {
    const identity = makeIdentity();
    const requests: Array<{ resourceMetadataUrl?: string }> = [];
    const coordinator = new OAuthTokenCoordinator({
      repository: new InMemoryOAuthCredentialRepository(),
      refresh: vi.fn<OAuthRefreshOperation>(),
      discover: async request => {
        requests.push({
          ...(request.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: request.resourceMetadataUrl }),
        });
        return makeDiscoveryResult();
      },
      now: () => 1_000,
    });

    await coordinator.ensureDiscovery(identity, {
      force: true,
      resourceMetadataUrl: "http://127.0.0.1:9/oauth-protected-resource",
    });
    expect(requests).toEqual([
      { resourceMetadataUrl: "http://127.0.0.1:9/oauth-protected-resource" },
    ]);
  });
});
