import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthCredentialState } from "../extensions/oauth/broker/credential-state.js";
import {
  FileOAuthCredentialRepository,
  OAUTH_BROKER_CREDENTIAL_FORMAT,
  OAUTH_BROKER_CREDENTIAL_VERSION,
} from "../extensions/oauth/broker/credential-repository.js";
import { createOAuthIdentity } from "../extensions/oauth/broker/identity.js";
import { getOAuthBrokerRuntimePaths } from "../extensions/oauth/broker/runtime-files.js";
import { OAuthTokenCoordinator } from "../extensions/oauth/broker/token-coordinator.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("just-enough-mcp-oauth-credentials");
const namespaceId = `agent-dir:v1:${"a".repeat(64)}`;

afterEach(() => tempDirs.cleanup());

function makeIdentity(profile = "default") {
  return createOAuthIdentity({
    namespaceId,
    resourceUrl: "https://mcp.example.test/rpc",
    clientMetadataUrl: "https://client.example.test/metadata.json",
    profile,
    requestHeaders: { "x-tenant": "alpha" },
  });
}

describe("OAuth broker credential repository", () => {
  it("以 v1 whole-document 原子格式持久化 refresh，并可由新 broker 恢复", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const refresh = vi.fn(async () => ({
      accessToken: "access-refreshed",
      accessTokenExpiresAt: 9_000,
      refreshToken: "refresh-rotated",
      scope: "write read",
    }));
    const coordinator = new OAuthTokenCoordinator({ repository, refresh, now: () => 1_000 });
    await coordinator.restore(identity, createOAuthCredentialState({
      credentialRevision: 4,
      authEpoch: 2,
      tokens: {
        accessToken: "access-expired",
        accessTokenExpiresAt: 0,
        refreshToken: "refresh-original",
        scope: "read write",
      },
    }));

    await expect(coordinator.getAccessToken(identity, {
      minRemainingMs: 100,
      scope: "read",
    })).resolves.toEqual({
      accessToken: "access-refreshed",
      accessTokenExpiresAt: 9_000,
      credentialRevision: 5,
    });

    const text = await readFile(getOAuthBrokerRuntimePaths(rootDir).credentialPath, "utf8");
    const document = JSON.parse(text) as {
      format: string;
      version: number;
      namespaceId: string;
      records: Array<{ identity: { key: string }; authorization: unknown }>;
    };
    expect(document).toMatchObject({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId,
    });
    expect(document.records).toHaveLength(1);
    expect(document.records[0]?.identity.key).toBe(identity.key);

    const reopened = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const restored = await reopened.read(identity);
    expect(restored).toEqual(createOAuthCredentialState({
      credentialRevision: 5,
      authEpoch: 2,
      tokens: {
        accessToken: "access-refreshed",
        accessTokenExpiresAt: 9_000,
        refreshToken: "refresh-rotated",
        scope: "read write",
      },
    }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("条件 logout 失败不改文件，成功后持久化 secret-free tombstone", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const coordinator = new OAuthTokenCoordinator({
      repository,
      refresh: async () => { throw new Error("unused"); },
    });
    await coordinator.restore(identity, createOAuthCredentialState({
      credentialRevision: 7,
      authEpoch: 3,
      tokens: {
        accessToken: "access-secret",
        accessTokenExpiresAt: 10_000,
        refreshToken: "refresh-secret",
      },
    }));
    const path = getOAuthBrokerRuntimePaths(rootDir).credentialPath;
    const before = await readFile(path, "utf8");

    await expect(coordinator.logout(identity, 6)).resolves.toMatchObject({ applied: false });
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(coordinator.logout(identity, 7)).resolves.toMatchObject({
      applied: true,
      credential: {
        credentialRevision: 8,
        authEpoch: 4,
        hasAccessToken: false,
        hasRefreshToken: false,
      },
    });

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("access-secret");
    expect(persisted).not.toContain("refresh-secret");
    const reopened = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    expect(await reopened.read(identity)).toEqual(createOAuthCredentialState({
      credentialRevision: 8,
      authEpoch: 4,
    }));
  });

  it("拒绝损坏、版本不匹配或跨 namespace 的 credential 文件", async () => {
    const rootDir = tempDirs.create();
    const initial = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await initial.mutate(makeIdentity(), state => ({ state, result: undefined }));
    const path = getOAuthBrokerRuntimePaths(rootDir).credentialPath;

    await writeFile(path, "{broken", "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("must contain valid JSON");

    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: 99,
      namespaceId,
      records: [],
    }), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("credential.version must be 1");

    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId: "other",
      records: [],
    }), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("namespace does not match");
  });
});
