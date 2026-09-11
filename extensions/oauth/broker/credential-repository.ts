import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  cloneOAuthCredentialState,
  createOAuthCredentialState,
  type OAuthCredentialState,
} from "./credential-state.ts";
import { parseOAuthIdentity, type OAuthIdentity } from "./identity.ts";
import {
  ensureOAuthBrokerRuntimeDirectories,
  getOAuthBrokerRuntimePaths,
} from "./runtime-files.ts";

export const OAUTH_BROKER_CREDENTIAL_FORMAT = "just-enough-mcp.oauth-broker-credentials" as const;
export const OAUTH_BROKER_CREDENTIAL_VERSION = 1 as const;

export interface OAuthCredentialMutation<T> {
  readonly state: OAuthCredentialState;
  readonly result: T;
  /** false 表示 transition 只读取状态，不触发持久化。默认 true。 */
  readonly changed?: boolean;
}

export interface OAuthCredentialRepository {
  read(identity: OAuthIdentity): Promise<OAuthCredentialState>;
  mutate<T>(
    identity: OAuthIdentity,
    transition: (state: OAuthCredentialState) => OAuthCredentialMutation<T>,
  ): Promise<T>;
}

interface StoredCredentialRecord {
  readonly identity: OAuthIdentity;
  readonly authorization: OAuthCredentialState;
}

interface StoredCredentialDocument {
  readonly format: typeof OAUTH_BROKER_CREDENTIAL_FORMAT;
  readonly version: typeof OAUTH_BROKER_CREDENTIAL_VERSION;
  readonly namespaceId: string;
  readonly records: readonly StoredCredentialRecord[];
}

/** Lightweight repository used by coordinator-only tests and protocol experiments. */
export class InMemoryOAuthCredentialRepository implements OAuthCredentialRepository {
  private readonly records = new Map<string, StoredCredentialRecord>();
  private mutationTail: Promise<void> = Promise.resolve();

  async read(identity: OAuthIdentity): Promise<OAuthCredentialState> {
    assertIdentityMatchesNamespace(identity, identity.namespaceId);
    return cloneOAuthCredentialState(
      this.records.get(identity.key)?.authorization ?? createOAuthCredentialState(),
    );
  }

  mutate<T>(
    identity: OAuthIdentity,
    transition: (state: OAuthCredentialState) => OAuthCredentialMutation<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.read(identity);
      const mutation = transition(current);
      const next = cloneOAuthCredentialState(mutation.state);
      if (mutation.changed !== false) {
        this.records.set(identity.key, { identity, authorization: next });
      }
      return mutation.result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * Broker-owned whole-document repository.
 *
 * Mutations are serialized, written to a temporary file, and atomically renamed before
 * the new in-memory snapshot becomes visible. A failed write therefore cannot publish a
 * credential state that would be lost after broker restart.
 */
export class FileOAuthCredentialRepository implements OAuthCredentialRepository {
  private readonly rootDir: string;
  private readonly namespaceId: string;
  private records: Map<string, StoredCredentialRecord>;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    rootDir: string,
    namespaceId: string,
    records: Map<string, StoredCredentialRecord>,
  ) {
    this.rootDir = rootDir;
    this.namespaceId = namespaceId;
    this.records = records;
  }

  static async open(rootDir: string, namespaceId: string): Promise<FileOAuthCredentialRepository> {
    requireNonEmpty(namespaceId, "namespaceId");
    await ensureOAuthBrokerRuntimeDirectories(rootDir);
    const records = await readCredentialRecords(rootDir, namespaceId);
    return new FileOAuthCredentialRepository(rootDir, namespaceId, records);
  }

  async read(identity: OAuthIdentity): Promise<OAuthCredentialState> {
    assertIdentityMatchesNamespace(identity, this.namespaceId);
    return cloneOAuthCredentialState(
      this.records.get(identity.key)?.authorization ?? createOAuthCredentialState(),
    );
  }

  mutate<T>(
    identity: OAuthIdentity,
    transition: (state: OAuthCredentialState) => OAuthCredentialMutation<T>,
  ): Promise<T> {
    assertIdentityMatchesNamespace(identity, this.namespaceId);
    return this.enqueue(async () => {
      const current = cloneOAuthCredentialState(
        this.records.get(identity.key)?.authorization ?? createOAuthCredentialState(),
      );
      const mutation = transition(current);
      const nextState = cloneOAuthCredentialState(mutation.state);
      if (mutation.changed === false) {
        return mutation.result;
      }

      const nextRecords = new Map(this.records);
      nextRecords.set(identity.key, { identity, authorization: nextState });
      await writeCredentialRecords(this.rootDir, this.namespaceId, nextRecords);
      this.records = nextRecords;
      return mutation.result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readCredentialRecords(
  rootDir: string,
  namespaceId: string,
): Promise<Map<string, StoredCredentialRecord>> {
  const { credentialPath } = getOAuthBrokerRuntimePaths(rootDir);
  let text: string;
  try {
    text = await readFile(credentialPath, "utf8");
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError("OAuth broker credential file must contain valid JSON.", { cause: error });
  }
  const document = parseCredentialDocument(value, namespaceId);
  return new Map(document.records.map(record => [record.identity.key, record]));
}

async function writeCredentialRecords(
  rootDir: string,
  namespaceId: string,
  records: ReadonlyMap<string, StoredCredentialRecord>,
): Promise<void> {
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const { credentialPath } = getOAuthBrokerRuntimePaths(rootDir);
  const document: StoredCredentialDocument = {
    format: OAUTH_BROKER_CREDENTIAL_FORMAT,
    version: OAUTH_BROKER_CREDENTIAL_VERSION,
    namespaceId,
    records: [...records.values()]
      .sort((left, right) => left.identity.key.localeCompare(right.identity.key))
      .map(record => ({
        identity: record.identity,
        authorization: cloneOAuthCredentialState(record.authorization),
      })),
  };
  const temporaryPath = `${credentialPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, credentialPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseCredentialDocument(value: unknown, namespaceId: string): StoredCredentialDocument {
  const record = requireRecord(value, "OAuth broker credential document");
  if (record.format !== OAUTH_BROKER_CREDENTIAL_FORMAT) {
    throw new TypeError(`credential.format must be ${JSON.stringify(OAUTH_BROKER_CREDENTIAL_FORMAT)}.`);
  }
  if (record.version !== OAUTH_BROKER_CREDENTIAL_VERSION) {
    throw new TypeError(`credential.version must be ${OAUTH_BROKER_CREDENTIAL_VERSION}.`);
  }
  if (record.namespaceId !== namespaceId) {
    throw new TypeError("OAuth broker credential namespace does not match this broker.");
  }
  if (!Array.isArray(record.records)) {
    throw new TypeError("credential.records must be an array.");
  }

  const seen = new Set<string>();
  const records = record.records.map((item, index) => {
    const stored = requireRecord(item, `credential.records[${index}]`);
    const identity = parseOAuthIdentity(stored.identity);
    assertIdentityMatchesNamespace(identity, namespaceId);
    if (seen.has(identity.key)) {
      throw new TypeError(`credential.records contains duplicate identity ${identity.key}.`);
    }
    seen.add(identity.key);
    return {
      identity,
      authorization: parseCredentialState(
        stored.authorization,
        `credential.records[${index}].authorization`,
      ),
    };
  });

  return {
    format: OAUTH_BROKER_CREDENTIAL_FORMAT,
    version: OAUTH_BROKER_CREDENTIAL_VERSION,
    namespaceId,
    records,
  };
}

function parseCredentialState(value: unknown, fieldName: string): OAuthCredentialState {
  const record = requireRecord(value, fieldName);
  const tokens = record.tokens === undefined
    ? undefined
    : parseTokens(record.tokens, `${fieldName}.tokens`);
  return createOAuthCredentialState({
    credentialRevision: requireNonNegativeSafeInteger(
      record.credentialRevision,
      `${fieldName}.credentialRevision`,
    ),
    authEpoch: requireNonNegativeSafeInteger(record.authEpoch, `${fieldName}.authEpoch`),
    ...(tokens ? { tokens } : {}),
  });
}

function parseTokens(value: unknown, fieldName: string) {
  const record = requireRecord(value, fieldName);
  return {
    accessToken: requireNonEmpty(record.accessToken, `${fieldName}.accessToken`),
    accessTokenExpiresAt: requireFinite(record.accessTokenExpiresAt, `${fieldName}.accessTokenExpiresAt`),
    ...(record.refreshToken === undefined
      ? {}
      : { refreshToken: requireNonEmpty(record.refreshToken, `${fieldName}.refreshToken`) }),
    ...(record.scope === undefined
      ? {}
      : { scope: requireNonEmpty(record.scope, `${fieldName}.scope`) }),
  };
}

function assertIdentityMatchesNamespace(identity: OAuthIdentity, namespaceId: string): void {
  if (identity.namespaceId !== namespaceId) {
    throw new TypeError("OAuth identity namespace does not match the credential repository.");
  }
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmpty(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireFinite(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number.`);
  }
  return value;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
