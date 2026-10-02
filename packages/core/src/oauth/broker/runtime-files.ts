import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OAUTH_BROKER_ACCESS_FORMAT,
  OAUTH_BROKER_PROTOCOL_VERSION,
  parseOAuthBrokerAccessDescriptor,
  type OAuthBrokerAccessDescriptor,
} from "./protocol.ts";

const ACCESS_FILE_NAME = "broker-access.json";
const CREDENTIAL_FILE_NAME = "broker-credentials.json";
const LOCK_TARGET_NAME = "broker-runtime";
const LOCK_FILE_NAME = "broker-runtime.lock";

export interface OAuthBrokerRuntimePaths {
  readonly rootDir: string;
  readonly accessPath: string;
  readonly credentialPath: string;
  /** proper-lockfile 会以显式 lockfilePath 锁定这个已存在的目录。 */
  readonly lockTargetPath: string;
  readonly lockPath: string;
}

export function getOAuthBrokerRuntimePaths(rootDir: string): OAuthBrokerRuntimePaths {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TypeError("OAuth broker rootDir must be a non-empty string.");
  }
  return {
    rootDir,
    accessPath: join(rootDir, ACCESS_FILE_NAME),
    credentialPath: join(rootDir, CREDENTIAL_FILE_NAME),
    lockTargetPath: join(rootDir, LOCK_TARGET_NAME),
    lockPath: join(rootDir, LOCK_FILE_NAME),
  };
}

export async function ensureOAuthBrokerRuntimeDirectories(rootDir: string): Promise<void> {
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  await mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.lockTargetPath, { recursive: true, mode: 0o700 });
}

/**
 * 读取最近发布的 access 快照。它的存在刻意不作为 liveness 信号：
 * 调用方必须先用 health 完成认证，才能复用它。
 */
export async function readOAuthBrokerAccess(
  rootDir: string,
): Promise<OAuthBrokerAccessDescriptor | undefined> {
  const { accessPath } = getOAuthBrokerRuntimePaths(rootDir);
  let text: string;
  try {
    text = await readFile(accessPath, "utf8");
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parseOAuthBrokerAccessDescriptor(JSON.parse(text) as unknown);
}

/**
 * 发布一份完整的 access 快照。旧文件会刻意保留到 rename 成功，
 * 因此崩溃的 broker 只会留下一个可读的陈旧文件。
 */
export async function writeOAuthBrokerAccess(
  rootDir: string,
  access: OAuthBrokerAccessDescriptor,
): Promise<void> {
  const parsed = parseOAuthBrokerAccessDescriptor({
    ...access,
    format: OAUTH_BROKER_ACCESS_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
  });
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const { accessPath } = getOAuthBrokerRuntimePaths(rootDir);
  const temporaryPath = `${accessPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, accessPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function removeOAuthBrokerAccess(rootDir: string): Promise<void> {
  await unlink(getOAuthBrokerRuntimePaths(rootDir).accessPath).catch(error => {
    if (!isErrorWithCode(error) || error.code !== "ENOENT") {
      throw error;
    }
  });
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
