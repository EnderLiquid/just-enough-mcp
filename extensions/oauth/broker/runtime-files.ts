import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  assertOAuthBrokerId,
  assertOAuthBrokerPublication,
  OAUTH_BROKER_PROTOCOL_VERSION,
  OAUTH_BROKER_RUNTIME_FORMAT,
  parseOAuthBrokerAccessDescriptor,
  parseOAuthBrokerEndpointDescriptor,
  parseOAuthBrokerOwnerClaim,
  parseOAuthBrokerRuntimeIdentity,
  type OAuthBrokerAccessDescriptor,
  type OAuthBrokerEndpointDescriptor,
  type OAuthBrokerOwnerClaim,
  type OAuthBrokerPublication,
  type OAuthBrokerRuntimeIdentity,
} from "./protocol.ts";

const RUNTIME_IDENTITY_FILE_NAME = "runtime.json";
const CLAIMS_DIRECTORY_NAME = "claims";
const ENDPOINTS_DIRECTORY_NAME = "endpoints";
const CLAIM_FILE_SUFFIX = ".json";
const ENDPOINT_FILE_NAME = "endpoint.json";
const ACCESS_FILE_NAME = "access.json";

export interface OAuthBrokerRuntimePaths {
  readonly rootDir: string;
  readonly identityPath: string;
  readonly claimsDir: string;
  readonly endpointsDir: string;
}

export interface OAuthBrokerPublicationPaths {
  readonly directory: string;
  readonly endpointPath: string;
  readonly accessPath: string;
}

export function getOAuthBrokerRuntimePaths(rootDir: string): OAuthBrokerRuntimePaths {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new TypeError("OAuth broker rootDir must be a non-empty string.");
  }
  return {
    rootDir,
    identityPath: join(rootDir, RUNTIME_IDENTITY_FILE_NAME),
    claimsDir: join(rootDir, CLAIMS_DIRECTORY_NAME),
    endpointsDir: join(rootDir, ENDPOINTS_DIRECTORY_NAME),
  };
}

export function getOAuthBrokerClaimPath(rootDir: string, claimId: string): string {
  assertOAuthBrokerId(claimId, "claimId");
  return join(getOAuthBrokerRuntimePaths(rootDir).claimsDir, `${claimId}${CLAIM_FILE_SUFFIX}`);
}

export function getOAuthBrokerPublicationPaths(
  rootDir: string,
  claimId: string,
): OAuthBrokerPublicationPaths {
  assertOAuthBrokerId(claimId, "claimId");
  const directory = join(getOAuthBrokerRuntimePaths(rootDir).endpointsDir, claimId);
  return {
    directory,
    endpointPath: join(directory, ENDPOINT_FILE_NAME),
    accessPath: join(directory, ACCESS_FILE_NAME),
  };
}

export async function ensureOAuthBrokerRuntimeDirectories(rootDir: string): Promise<void> {
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  await mkdir(paths.claimsDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.endpointsDir, { recursive: true, mode: 0o700 });
}

export class OAuthBrokerRuntimeIdentityMismatchError extends Error {
  readonly code = "runtime-identity-mismatch" as const;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OAuthBrokerRuntimeIdentityMismatchError";
  }
}

/** 将 runtime directory 永久绑定到一个 namespace 和 HTTP protocol version。 */
export async function ensureOAuthBrokerRuntimeIdentity(
  rootDir: string,
  namespaceId: string,
): Promise<OAuthBrokerRuntimeIdentity> {
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  const expected: OAuthBrokerRuntimeIdentity = {
    format: OAUTH_BROKER_RUNTIME_FORMAT,
    protocolVersion: OAUTH_BROKER_PROTOCOL_VERSION,
    namespaceId,
  };

  try {
    await writeJsonExclusively(paths.identityPath, expected);
    return expected;
  } catch (error) {
    if (!isErrorWithCode(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const value = await readJsonIfPresent(paths.identityPath);
    const existing = parseOAuthBrokerRuntimeIdentity(value);
    if (existing.namespaceId !== namespaceId) {
      throw new OAuthBrokerRuntimeIdentityMismatchError(
        "OAuth broker runtime directory belongs to a different agentDir namespace.",
      );
    }
    return existing;
  } catch (error) {
    if (error instanceof OAuthBrokerRuntimeIdentityMismatchError) {
      throw error;
    }
    throw new OAuthBrokerRuntimeIdentityMismatchError(
      "OAuth broker runtime identity is missing, corrupt, or uses an incompatible protocol version.",
      { cause: error },
    );
  }
}

export async function createOAuthBrokerClaim(
  rootDir: string,
  claim: OAuthBrokerOwnerClaim,
): Promise<void> {
  const parsed = parseOAuthBrokerOwnerClaim(claim);
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  await writeJsonExclusively(getOAuthBrokerClaimPath(rootDir, parsed.claimId), parsed);
}

export async function readOAuthBrokerClaim(
  rootDir: string,
  claimId: string,
): Promise<OAuthBrokerOwnerClaim | undefined> {
  const value = await readJsonIfPresent(getOAuthBrokerClaimPath(rootDir, claimId));
  return value === undefined ? undefined : parseOAuthBrokerOwnerClaim(value);
}

export async function listOAuthBrokerClaims(rootDir: string): Promise<OAuthBrokerOwnerClaim[]> {
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  const entries = await readDirectoryIfPresent(paths.claimsDir);
  const claims: OAuthBrokerOwnerClaim[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CLAIM_FILE_SUFFIX)) {
      continue;
    }
    const claimId = entry.name.slice(0, -CLAIM_FILE_SUFFIX.length);
    try {
      assertOAuthBrokerId(claimId, "claimId");
      const claim = await readOAuthBrokerClaim(rootDir, claimId);
      if (claim) {
        claims.push(claim);
      }
    } catch {
      // Corrupt or unrelated files never participate in owner election.
    }
  }

  return claims;
}

/**
 * access 先落盘、endpoint 最后发布。发现方只扫描 endpoint，因此不会看到半条 publication。
 */
export async function writeOAuthBrokerPublication(
  rootDir: string,
  publication: OAuthBrokerPublication,
): Promise<void> {
  const parsed = assertOAuthBrokerPublication({
    endpoint: parseOAuthBrokerEndpointDescriptor(publication.endpoint),
    access: parseOAuthBrokerAccessDescriptor(publication.access),
  });
  await ensureOAuthBrokerRuntimeDirectories(rootDir);
  const paths = getOAuthBrokerPublicationPaths(rootDir, parsed.endpoint.claimId);
  await mkdir(paths.directory, { mode: 0o700 });

  try {
    await writeJsonAtomically(paths.accessPath, parsed.access);
    await writeJsonAtomically(paths.endpointPath, parsed.endpoint);
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readOAuthBrokerPublication(
  rootDir: string,
  claimId: string,
): Promise<OAuthBrokerPublication | undefined> {
  const paths = getOAuthBrokerPublicationPaths(rootDir, claimId);
  const endpointValue = await readJsonIfPresent(paths.endpointPath);
  if (endpointValue === undefined) {
    return undefined;
  }
  const accessValue = await readJsonIfPresent(paths.accessPath);
  if (accessValue === undefined) {
    return undefined;
  }

  return assertOAuthBrokerPublication({
    endpoint: parseOAuthBrokerEndpointDescriptor(endpointValue),
    access: parseOAuthBrokerAccessDescriptor(accessValue),
  });
}

export async function listOAuthBrokerPublications(
  rootDir: string,
): Promise<OAuthBrokerPublication[]> {
  const paths = getOAuthBrokerRuntimePaths(rootDir);
  const entries = await readDirectoryIfPresent(paths.endpointsDir);
  const publications: OAuthBrokerPublication[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      assertOAuthBrokerId(entry.name, "claimId");
      const publication = await readOAuthBrokerPublication(rootDir, entry.name);
      if (publication) {
        publications.push(publication);
      }
    } catch {
      // Invalid or partially written candidates are ignored until their unique path is reaped.
    }
  }

  return publications;
}

/** Unique claimId paths are never reused, so cleanup cannot delete a newer owner's files. */
export async function removeOAuthBrokerCandidate(
  rootDir: string,
  claimId: string,
): Promise<void> {
  assertOAuthBrokerId(claimId, "claimId");
  const publicationPaths = getOAuthBrokerPublicationPaths(rootDir, claimId);
  await rm(publicationPaths.directory, { recursive: true, force: true });
  await unlink(getOAuthBrokerClaimPath(rootDir, claimId)).catch(error => {
    if (!isErrorWithCode(error) || error.code !== "ENOENT") {
      throw error;
    }
  });
}

export async function writeJsonExclusively(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readDirectoryIfPresent(
  directory: string,
): Promise<Dirent<string>[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
