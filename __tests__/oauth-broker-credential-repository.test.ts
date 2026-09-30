import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthCredentialState } from "../src/core/oauth/broker/credential-state.js";
import { createOAuthCredentialRecord } from "../src/core/oauth/broker/credential-record.js";
import {
  FileOAuthCredentialRepository,
  OAUTH_BROKER_CREDENTIAL_FORMAT,
  OAUTH_BROKER_CREDENTIAL_VERSION,
} from "../src/core/oauth/broker/credential-repository.js";
import { createOAuthIdentity } from "../src/core/oauth/broker/identity.js";
import { getOAuthBrokerRuntimePaths } from "../src/core/oauth/broker/runtime-files.js";
import { OAuthTokenCoordinator } from "../src/core/oauth/broker/token-coordinator.js";
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

function makeAuthorizedRecord(authorization: ReturnType<typeof createOAuthCredentialState>) {
  return createOAuthCredentialRecord({
    authorization,
    registration: {
      strategy: "dcr",
      authorizationServerUrl: "https://as.example.test/",
      clientInformation: {
        client_id: "client-1",
        redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      },
    },
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
    await coordinator.restore(identity, makeAuthorizedRecord(createOAuthCredentialState({
      credentialRevision: 4,
      authEpoch: 2,
      tokens: {
        accessToken: "access-expired",
        accessTokenExpiresAt: 0,
        refreshToken: "refresh-original",
        scope: "read write",
      },
    })));

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
    await coordinator.restore(identity, makeAuthorizedRecord(createOAuthCredentialState({
      credentialRevision: 7,
      authEpoch: 3,
      tokens: {
        accessToken: "access-secret",
        accessTokenExpiresAt: 10_000,
        refreshToken: "refresh-secret",
      },
    })));
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

  it("持久化 registration、discovery 与追加 scope，并在 reopen 后恢复", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({
      record: {
        ...record,
        registration: {
          strategy: "dcr",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: {
            client_id: "client-1",
            redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
          },
        },
        discovery: {
          authorizationServerUrl: "https://as.example.test",
          fetchedAt: 1_000,
          authorizationServerMetadata: {
            issuer: "https://as.example.test",
            authorization_endpoint: "https://as.example.test/authorize",
            token_endpoint: "https://as.example.test/token",
            response_types_supported: ["code"],
          },
          resourceMetadata: { resource: "https://mcp.example.test/rpc" },
        },
        challengedScopes: ["write", "admin"],
      },
      result: undefined,
    }));

    const reopened = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const restored = await reopened.readRecord(identity);
    expect(restored.registration).toEqual({
      strategy: "dcr",
      authorizationServerUrl: "https://as.example.test/",
      clientInformation: {
        client_id: "client-1",
        redirect_uris: ["http://127.0.0.1:33418/oauth/callback"],
      },
    });
    expect(restored.discovery).toMatchObject({
      authorizationServerUrl: "https://as.example.test/",
      fetchedAt: 1_000,
      authorizationServerMetadata: {
        token_endpoint: "https://as.example.test/token",
      },
      resourceMetadata: { resource: "https://mcp.example.test/rpc" },
    });
    expect(restored.challengedScopes).toEqual(["admin", "write"]);
  });

  it("始终写入 challengedScopes，并拒绝缺少当前必填字段的记录", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({ record, result: undefined }));
    const path = getOAuthBrokerRuntimePaths(rootDir).credentialPath;
    const text = await readFile(path, "utf8");
    expect(text).toContain('"challengedScopes":[]');

    const document = JSON.parse(text) as { records: Array<Record<string, unknown>> };
    delete document.records[0]!.challengedScopes;
    await writeFile(path, JSON.stringify(document), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("challengedScopes must be an array");
  });

  it("拒绝携带 token 但缺少 registration 的持久化记录", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    const path = getOAuthBrokerRuntimePaths(rootDir).credentialPath;
    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId,
      records: [{
        identity,
        authorization: {
          credentialRevision: 1,
          authEpoch: 0,
          tokens: {
            accessToken: "access-token",
            accessTokenExpiresAt: 1_000,
            refreshToken: "refresh-token",
          },
        },
        challengedScopes: [],
      }],
    }), "utf8");

    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("OAuth token credentials must include a client registration");
  });

  it("拒绝损坏的 registration、discovery 与追加 scope 记录", async () => {
    const rootDir = tempDirs.create();
    const identity = makeIdentity();
    const repository = await FileOAuthCredentialRepository.open(rootDir, namespaceId);
    await repository.mutateRecord(identity, record => ({ record, result: undefined }));
    const path = getOAuthBrokerRuntimePaths(rootDir).credentialPath;
    const authorization = { credentialRevision: 0, authEpoch: 0 };

    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId,
      records: [{
        identity,
        authorization,
        registration: {
          strategy: "cimd",
          authorizationServerUrl: "https://as.example.test",
          clientInformation: { client_id: "client-1" },
        },
        challengedScopes: [],
      }],
    }), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow('registration.strategy must be "dcr"');

    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId,
      records: [{
        identity,
        authorization,
        discovery: { authorizationServerUrl: "https://as.example.test", fetchedAt: -1 },
        challengedScopes: [],
      }],
    }), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("fetchedAt must be non-negative");

    await writeFile(path, JSON.stringify({
      format: OAUTH_BROKER_CREDENTIAL_FORMAT,
      version: OAUTH_BROKER_CREDENTIAL_VERSION,
      namespaceId,
      records: [{ identity, authorization, challengedScopes: ["bad scope"] }],
    }), "utf8");
    await expect(FileOAuthCredentialRepository.open(rootDir, namespaceId))
      .rejects.toThrow("must be a valid OAuth scope token");
  });
});
