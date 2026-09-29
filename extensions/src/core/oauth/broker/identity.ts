import { createHash } from "node:crypto";

export const OAUTH_IDENTITY_VERSION = 1 as const;

export interface OAuthIdentityInput {
  /** 由 agentDir broker namespace 提供的稳定、不含路径语义的标识。 */
  namespaceId: string;
  resourceUrl: string | URL;
  clientMetadataUrl?: string | URL | null;
  profile?: string;
  requestHeaders?: Readonly<Record<string, string>>;
}

export interface OAuthIdentityV1 {
  identityVersion: typeof OAUTH_IDENTITY_VERSION;
  namespaceId: string;
  resourceUrl: string;
  clientMetadataUrl: string | null;
  profile: string;
  requestHeadersDigest: string;
  key: `oauth:v1:${string}`;
}

export type OAuthIdentity = OAuthIdentityV1;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function canonicalizeHttpUrl(value: string | URL, fieldName: string): string {
  const rawValue = value instanceof URL ? value.toString() : requireNonEmptyString(value, fieldName);
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new TypeError(`${fieldName} must be an absolute HTTP URL.`);
  }

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(`${fieldName} must use http or https.`);
  }
  return url.toString();
}

function canonicalizeClientMetadataUrl(value: string | URL): string {
  const canonical = canonicalizeHttpUrl(value, "clientMetadataUrl");
  const url = new URL(canonical);
  if (url.protocol !== "https:" || url.pathname === "/") {
    throw new TypeError("clientMetadataUrl must be an HTTPS URL with a non-root path.");
  }
  return canonical;
}

function canonicalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Array<readonly [string, string]> {
  if (headers === undefined) {
    return [];
  }

  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new TypeError(`requestHeaders contains an invalid header name: ${name}`);
    }
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
      throw new TypeError(`requestHeaders.${name} must be a header-safe string.`);
    }

    const normalizedName = name.toLowerCase();
    if (normalized.has(normalizedName)) {
      throw new TypeError(`requestHeaders contains duplicate case-insensitive header: ${normalizedName}`);
    }
    normalized.set(normalizedName, value);
  }

  return [...normalized.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => [name, value] as const);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createRequestHeadersDigest(
  headers: Readonly<Record<string, string>> | undefined,
): string {
  return sha256(JSON.stringify(canonicalizeHeaders(headers)));
}

function createOAuthIdentityFromCanonicalFields(input: {
  namespaceId: string;
  resourceUrl: string;
  clientMetadataUrl: string | null;
  profile: string;
  requestHeadersDigest: string;
}): OAuthIdentityV1 {
  const keyMaterial = JSON.stringify({
    identityVersion: OAUTH_IDENTITY_VERSION,
    ...input,
  });
  return {
    identityVersion: OAUTH_IDENTITY_VERSION,
    ...input,
    key: `oauth:v1:${sha256(keyMaterial)}`,
  };
}

export function createOAuthIdentity(input: OAuthIdentityInput): OAuthIdentityV1 {
  const namespaceId = requireNonEmptyString(input.namespaceId, "namespaceId");
  const resourceUrl = canonicalizeHttpUrl(input.resourceUrl, "resourceUrl");
  const clientMetadataUrl = input.clientMetadataUrl == null
    ? null
    : canonicalizeClientMetadataUrl(input.clientMetadataUrl);
  const profile = input.profile === undefined
    ? "default"
    : requireNonEmptyString(input.profile, "profile");
  const requestHeadersDigest = createRequestHeadersDigest(input.requestHeaders);

  return createOAuthIdentityFromCanonicalFields({
    namespaceId,
    resourceUrl,
    clientMetadataUrl,
    profile,
    requestHeadersDigest,
  });
}

/** Parses an identity sent over the broker boundary and verifies its derived key. */
export function parseOAuthIdentity(value: unknown): OAuthIdentityV1 {
  const record = requireRecord(value, "OAuth identity");
  if (record.identityVersion !== OAUTH_IDENTITY_VERSION) {
    throw new TypeError(`identity.identityVersion must be ${OAUTH_IDENTITY_VERSION}.`);
  }
  const namespaceId = requireNonEmptyString(record.namespaceId, "identity.namespaceId");
  const resourceUrl = canonicalizeHttpUrl(
    requireNonEmptyString(record.resourceUrl, "identity.resourceUrl"),
    "identity.resourceUrl",
  );
  const clientMetadataUrl = record.clientMetadataUrl === null
    ? null
    : canonicalizeClientMetadataUrl(
      requireNonEmptyString(record.clientMetadataUrl, "identity.clientMetadataUrl"),
    );
  const profile = requireNonEmptyString(record.profile, "identity.profile");
  const requestHeadersDigest = requireNonEmptyString(
    record.requestHeadersDigest,
    "identity.requestHeadersDigest",
  );
  if (!SHA256_PATTERN.test(requestHeadersDigest)) {
    throw new TypeError("identity.requestHeadersDigest must be a lowercase SHA-256 digest.");
  }

  const identity = createOAuthIdentityFromCanonicalFields({
    namespaceId,
    resourceUrl,
    clientMetadataUrl,
    profile,
    requestHeadersDigest,
  });
  if (record.key !== identity.key) {
    throw new TypeError("identity.key does not match the canonical OAuth identity fields.");
  }
  return identity;
}
