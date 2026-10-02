import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthCredentialRecord } from "../packages/core/src/oauth/broker/credential-record.js";
import { createOAuthCredentialState } from "../packages/core/src/oauth/broker/credential-state.js";
import { FileOAuthCredentialRepository } from "../packages/core/src/oauth/broker/credential-repository.js";
import { createOAuthIdentity } from "../packages/core/src/oauth/broker/identity.js";
import { getOAuthBrokerRuntimePaths } from "../packages/core/src/oauth/broker/runtime-files.js";
import {
  OAuthPermanentRefreshError,
  OAuthTokenCoordinator,
} from "../packages/core/src/oauth/broker/token-coordinator.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-crash");
const namespaceId = `agent-dir:v1:${"b".repeat(64)}`;

afterEach(() => tempDirs.cleanup());

function makeIdentity() {
  return createOAuthIdentity({
    namespaceId,
    resourceUrl: "https://mcp.example.test/rpc",
    profile: "default",
  });
}

function withTokens(revision: number, access: string, refresh: string) {
  return createOAuthCredentialState({
    credentialRevision: revision,
    authEpoch: 0,
    tokens: {
      accessToken: access,
      accessTokenExpiresAt: 10_000,
      refreshToken: refresh,
    },
  });
}

function makeRegistration() {
  return {
    strategy: "dcr" as const,
    authorizationServerUrl: "https://as.example.test/",
    clientInformation: {
      client_id: "client-1",
      redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
    },
  };
}

function makeAuthorizedRecord(authorization: ReturnType<typeof withTokens>) {
  return createOAuthCredentialRecord({
    authorization,
    registration: makeRegistration(),
  });
}

/**
 * decision.md 第 8 节的持久化恢复语义只有一条：原子 rename。
 * 这些用例验证该语义的可观察结果，不模拟真实进程崩溃。
 */
describe("OAuth broker credential 持久化恢复", () => {
  it("rename 失败时不发布内存快照，并清理临时文件", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: withTokens(1, "access-original", "refresh-original"),
        registration: makeRegistration(),
      },
      result: undefined,
    }));

    // 让 rename 目标变成目录，制造提交失败。
    const { credentialPath } = getOAuthBrokerRuntimePaths(rootDir);
    await unlink(credentialPath);
    await mkdir(credentialPath);

    await expect(repository.mutateRecord(identity, record => ({
      record: { ...record, authorization: withTokens(9, "access-new", "refresh-new") },
      result: undefined,
    }))).rejects.toThrow();

    // 内存快照仍是旧值：commit 失败不得让未持久化的状态可见。
    const record = await repository.readRecord(identity);
    expect(record.authorization.tokens?.accessToken).toBe("access-original");
    expect(record.authorization.credentialRevision).toBe(1);

    // 失败路径必须清掉自己的临时文件，不留半写产物。
    const entries = await readdir(rootDir);
    expect(entries.filter(name => name.startsWith("broker-credentials.json.tmp-"))).toEqual([]);
  });

  it("残留的临时文件不被读取，也不影响 reopen", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        authorization: withTokens(3, "access-committed", "refresh-committed"),
        registration: makeRegistration(),
      },
      result: undefined,
    }));

    const { credentialPath } = getOAuthBrokerRuntimePaths(rootDir);
    // 模拟「写入临时文件后进程死掉」：临时文件留在目录里。
    await writeFile(`${credentialPath}.tmp-999-deadbeef`, "{\"partial\":true}", "utf8");

    const reopened = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const record = await reopened.readRecord(identity);
    expect(record.authorization.tokens?.accessToken).toBe("access-committed");
    expect(record.authorization.credentialRevision).toBe(3);
  });

  it("rename 后 broker 崩溃：新 broker 恢复已提交的 rotation 并继续轮转", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const first = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const firstRefresh = vi.fn(async () => ({
      accessToken: "access-first",
      accessTokenExpiresAt: 5_000,
      refreshToken: "refresh-rotated",
    }));
    const firstCoordinator = new OAuthTokenCoordinator({
      repository: first,
      refresh: firstRefresh,
      now: () => 1_000,
    });
    await firstCoordinator.restore(
      identity,
      makeAuthorizedRecord(withTokens(1, "access-stale", "refresh-original")),
    );
    await firstCoordinator.getAccessToken(identity, { minRemainingMs: 0 });
    expect(firstRefresh).toHaveBeenCalledTimes(1);

    // 第一个 broker 「崩溃」：不复用它，直接开新实例与新的 coordinator。
    const second = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const secondRefresh = vi.fn(async () => ({
      accessToken: "access-second",
      accessTokenExpiresAt: 30_000,
      refreshToken: "refresh-rotated-again",
    }));
    const secondCoordinator = new OAuthTokenCoordinator({
      repository: second,
      refresh: secondRefresh,
      now: () => 2_000,
    });

    const snapshot = await secondCoordinator.getAccessToken(identity, { minRemainingMs: 0 });
    expect(snapshot.accessToken).toBe("access-second");
    // 续用已持久化的 rotated refresh token，而不是最初那个。
    expect(secondRefresh).toHaveBeenCalledWith(expect.objectContaining({
      refreshToken: "refresh-rotated",
    }));
  });

  it("rotation 已生效但本地仍是旧 refresh token 时按永久 credential 失败处理", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const refresh = vi.fn(async () => {
      throw new OAuthPermanentRefreshError("invalid_grant", { reason: "invalid-grant" });
    });
    const coordinator = new OAuthTokenCoordinator({ repository, refresh, now: () => 1_000 });
    await coordinator.restore(
      identity,
      makeAuthorizedRecord(withTokens(1, "access-stale", "refresh-old")),
    );

    await expect(coordinator.getAccessToken(identity, { minRemainingMs: 0 }))
      .rejects.toMatchObject({ code: "authorization-required", reason: "credential-rejected" });

    const record = await repository.readRecord(identity);
    expect(record.authorization.tokens).toBeUndefined();
    expect(record.authorization.credentialRevision).toBe(2);
  });

  it("token endpoint 成功但写盘失败时，操作失败且内存保持旧快照", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const coordinator = new OAuthTokenCoordinator({ repository, refresh: async () => {
      throw new Error("unused");
    } });
    await coordinator.restore(
      identity,
      makeAuthorizedRecord(withTokens(1, "access-old", "refresh-old")),
    );

    // 提交阶段让 rename 目标变成目录。
    const { credentialPath } = getOAuthBrokerRuntimePaths(rootDir);
    await unlink(credentialPath);
    await mkdir(credentialPath);

    const refresh = vi.fn(async () => ({
      accessToken: "access-rotated",
      accessTokenExpiresAt: 60_000,
      refreshToken: "refresh-rotated",
    }));
    const rotating = new OAuthTokenCoordinator({ repository, refresh, now: () => 2_000 });

    await expect(rotating.getAccessToken(identity, { minRemainingMs: 0 })).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
    // 本次操作失败；旧快照仍可读，下一次调用会重新尝试 refresh。
    const record = await repository.readRecord(identity);
    expect(record.authorization.tokens?.refreshToken).toBe("refresh-old");
  });
});
