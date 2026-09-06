import { describe, expect, it, vi } from "vitest";
import { createOAuthIdentity, type OAuthIdentity } from "../extensions/oauth/broker/identity.js";
import {
  createOAuthCredentialState,
  type OAuthTokenUpdate,
} from "../extensions/oauth/broker/credential-state.js";
import {
  OAuthAuthorizationRequiredError,
  OAuthCredentialChangedError,
  OAuthTokenCoordinator,
  type OAuthRefreshOperation,
} from "../extensions/oauth/broker/token-coordinator.js";

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
  return new OAuthTokenCoordinator({ refresh, now: () => now });
}

describe("OAuth credential state", () => {
  it("返回不含 refresh token 的 token snapshot", async () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    coordinator.restore(identity, makeState("access-current", 2_000, "refresh-secret", 7, 2));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-current",
      accessTokenExpiresAt: 2_000,
      credentialRevision: 7,
    });
    expect(coordinator.getCredentialView(identity)).toEqual({
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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 4, 3));

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
    expect(coordinator.getCredentialView(identity)).toMatchObject({
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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 1, 0));

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
    coordinator.restore(identity, makeState("access-rejected", 4_000, "refresh-old", 8, 1));

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
    coordinator.restore(identity, makeState("access-new", 4_000, "refresh-new", 9, 1));

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
    coordinator.restore(identity, createOAuthCredentialState({
      credentialRevision: 2,
      authEpoch: 1,
      tokens: {
        accessToken: "access-old",
        accessTokenExpiresAt: 0,
      },
    }));

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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 3, 2));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).rejects.toBe(failure);
    expect(coordinator.getCredentialView(identity)).toMatchObject({
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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-keep", 3, 2));

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 100 })).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: 4_000,
      credentialRevision: 4,
    });
    expect(coordinator.getCredentialView(identity)).toMatchObject({
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

  it("条件 logout 的 revision 不匹配时不清除更新后的 credential", () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    coordinator.restore(identity, makeState("access-new", 4_000, "refresh-new", 9, 2));

    expect(coordinator.logout(identity, 8)).toEqual({
      applied: false,
      credential: {
        credentialRevision: 9,
        authEpoch: 2,
        hasAccessToken: true,
        accessTokenExpiresAt: 4_000,
        hasRefreshToken: true,
      },
    });
    expect(coordinator.getCredentialView(identity).hasAccessToken).toBe(true);

    expect(coordinator.logout(identity, 9)).toEqual({
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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 4, 1));

    await coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    expect(coordinator.logout(identity, 4)).toMatchObject({ applied: false });
    expect(coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 5,
      authEpoch: 1,
      hasAccessToken: true,
      hasRefreshToken: true,
    });
  });

  it("logout 不等待 refresh，且迟到的 refresh 结果被 revision/epoch fence 丢弃", async () => {
    const identity = makeIdentity();
    const gate = deferred<OAuthTokenUpdate>();
    const refresh = vi.fn<OAuthRefreshOperation>(async () => gate.promise);
    const coordinator = makeCoordinator(refresh);
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 6, 4));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(coordinator.logout(identity, 6)).toMatchObject({ applied: true });

    gate.resolve({
      accessToken: "access-stale",
      accessTokenExpiresAt: 9_000,
      refreshToken: "refresh-stale",
    });
    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialChangedError);
    expect(coordinator.getCredentialView(identity)).toMatchObject({
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
    coordinator.restore(identity, makeState("access-old", 0, "refresh-old", 2, 5));

    const pending = coordinator.getAccessToken(identity, { minRemainingMs: 100 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const fence = coordinator.beginAuthorization(identity);
    expect(fence).toEqual({ credentialRevision: 2, authEpoch: 6 });
    expect(coordinator.commitAuthorization(identity, fence, {
      accessToken: "access-authorized",
      accessTokenExpiresAt: 8_000,
      refreshToken: "refresh-authorized",
    })).toBe(true);

    gate.resolve({ accessToken: "access-stale", accessTokenExpiresAt: 9_000 });
    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialChangedError);
    expect(coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 3,
      authEpoch: 6,
      hasAccessToken: true,
      accessTokenExpiresAt: 8_000,
      hasRefreshToken: true,
    });
  });

  it("旧 authorization fence 不能提交到更新后的授权生命周期", () => {
    const identity = makeIdentity();
    const refresh = vi.fn<OAuthRefreshOperation>();
    const coordinator = makeCoordinator(refresh);
    coordinator.restore(identity, makeState("access-old", 4_000, "refresh-old", 2, 5));

    const oldFence = coordinator.beginAuthorization(identity);
    const newFence = coordinator.beginAuthorization(identity);
    expect(coordinator.commitAuthorization(identity, oldFence, {
      accessToken: "access-stale",
      accessTokenExpiresAt: 6_000,
      refreshToken: "refresh-stale",
    })).toBe(false);
    expect(coordinator.commitAuthorization(identity, newFence, {
      accessToken: "access-current",
      accessTokenExpiresAt: 7_000,
      refreshToken: "refresh-current",
    })).toBe(true);
    expect(coordinator.getCredentialView(identity)).toMatchObject({
      credentialRevision: 3,
      authEpoch: 7,
      accessTokenExpiresAt: 7_000,
    });
  });
});
