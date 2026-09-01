import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncReadWriteLock } from "../concurrency/async-read-write-lock.js";

export interface OauthCredentialIdentity {
  serverName: string;
  serverUrl: string;
  clientMetadataUrl?: string;
}

export interface OauthCredentialRecord {
  serverUrl: string;
  clientMetadataUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

export const OAUTH_CREDENTIAL_FILE_VERSION = 1;

interface OauthCredentialFile {
  version: typeof OAUTH_CREDENTIAL_FILE_VERSION;
  records: Record<string, OauthCredentialRecord>;
}

const EMPTY_CREDENTIAL_FILE: OauthCredentialFile = {
  version: OAUTH_CREDENTIAL_FILE_VERSION,
  records: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeIdentity(identity: OauthCredentialIdentity): OauthCredentialIdentity {
  return {
    serverName: identity.serverName,
    serverUrl: identity.serverUrl,
    ...(identity.clientMetadataUrl ? { clientMetadataUrl: identity.clientMetadataUrl } : {}),
  };
}

function matchesIdentity(record: OauthCredentialRecord, identity: OauthCredentialIdentity): boolean {
  return record.serverUrl === identity.serverUrl
    && record.clientMetadataUrl === identity.clientMetadataUrl;
}

/**
 * 在常规插件配置之外持久化 OAuth client 注册信息和 token。
 *
 * MVP 阶段使用紧凑的 JSON 文档。进程内访问会串行化，并通过同目录 rename
 * 提交；该实现不承诺提供操作系统密钥链保护。
 */
export class OauthCredentialStore {
  private readonly lock = new AsyncReadWriteLock();

  constructor(readonly filePath: string) {}

  async read(identity: OauthCredentialIdentity): Promise<OauthCredentialRecord | undefined> {
    const normalized = normalizeIdentity(identity);
    return this.lock.withRead(async () => {
      const file = await this.loadFile();
      const record = file.records[normalized.serverName];
      return record && matchesIdentity(record, normalized) ? clone(record) : undefined;
    });
  }

  async saveClientInformation(
    identity: OauthCredentialIdentity,
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.update(identity, record => ({
      ...record,
      clientInformation: clone(clientInformation),
    }));
  }

  async saveTokens(identity: OauthCredentialIdentity, tokens: OAuthTokens): Promise<void> {
    await this.update(identity, record => ({
      ...record,
      tokens: clone(tokens),
    }));
  }

  async clearTokens(identity: OauthCredentialIdentity): Promise<void> {
    await this.update(identity, record => {
      const { tokens: _tokens, ...withoutTokens } = record;
      return withoutTokens;
    });
  }

  async clearAll(identity: OauthCredentialIdentity): Promise<void> {
    const normalized = normalizeIdentity(identity);
    await this.lock.withWrite(async () => {
      const file = await this.loadFile();
      const record = file.records[normalized.serverName];
      if (!record || !matchesIdentity(record, normalized)) {
        return;
      }

      delete file.records[normalized.serverName];
      await this.saveFile(file);
    });
  }

  private async update(
    identity: OauthCredentialIdentity,
    updateRecord: (record: OauthCredentialRecord) => OauthCredentialRecord,
  ): Promise<void> {
    const normalized = normalizeIdentity(identity);
    await this.lock.withWrite(async () => {
      const file = await this.loadFile();
      const existing = file.records[normalized.serverName];
      const record = existing && matchesIdentity(existing, normalized)
        ? existing
        : {
            serverUrl: normalized.serverUrl,
            ...(normalized.clientMetadataUrl ? { clientMetadataUrl: normalized.clientMetadataUrl } : {}),
          };
      file.records[normalized.serverName] = updateRecord(record);
      await this.saveFile(file);
    });
  }

  private async loadFile(): Promise<OauthCredentialFile> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return clone(EMPTY_CREDENTIAL_FILE);
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`OAuth credential file is not valid JSON: ${this.filePath}`);
    }

    if (!isRecord(parsed) || parsed.version !== OAUTH_CREDENTIAL_FILE_VERSION || !isRecord(parsed.records)) {
      throw new Error(`OAuth credential file has an unsupported format: ${this.filePath}`);
    }

    const records: Record<string, OauthCredentialRecord> = {};
    for (const [serverName, rawRecord] of Object.entries(parsed.records)) {
      if (!isRecord(rawRecord) || typeof rawRecord.serverUrl !== "string") {
        throw new Error(`OAuth credential file has an invalid record for server "${serverName}".`);
      }
      if (rawRecord.clientMetadataUrl !== undefined && typeof rawRecord.clientMetadataUrl !== "string") {
        throw new Error(`OAuth credential file has an invalid record for server "${serverName}".`);
      }
      records[serverName] = rawRecord as unknown as OauthCredentialRecord;
    }

    return { version: OAUTH_CREDENTIAL_FILE_VERSION, records };
  }

  private async saveFile(file: OauthCredentialFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const stagingPath = `${this.filePath}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(file, null, 2)}\n`;

    await writeFile(stagingPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(stagingPath, 0o600).catch(() => undefined);
    await rename(stagingPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
