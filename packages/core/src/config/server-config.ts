import { isAbsolute } from "node:path";
import {
  DEFAULT_CONNECTION_MODE,
  type ResolvedHttpTransport,
  type ResolvedOauthConfig,
  type ResolvedServerConfig,
  type ResolvedServerTransport,
  type ResolvedStdioTransport,
  type ResolvedToolFilter,
  type ServerConnectionMode,
  type ServerDefinition,
} from "../modeling/types.js";

export type InvalidServerConfigCode =
  | "invalid-server-name"
  | "invalid-server-definition";

export class InvalidServerConfigError extends Error {
  readonly code: InvalidServerConfigCode;
  readonly fieldPath: string | undefined;

  constructor(
    message: string,
    code: InvalidServerConfigCode = "invalid-server-definition",
    fieldPath?: string,
  ) {
    super(message);
    this.name = "InvalidServerConfigError";
    this.code = code;
    this.fieldPath = fieldPath;
  }
}

export interface ParsedServerConfig {
  connectionMode: ServerConnectionMode;
  configuredOverviewPath?: string;
  transport: ResolvedServerTransport;
  toolFilter: ResolvedToolFilter;
}

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  message: string,
  fieldPath?: string,
): never {
  throw new InvalidServerConfigError(message, "invalid-server-definition", fieldPath);
}

export function assertValidServerName(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new InvalidServerConfigError(
      `MCP server name "${serverName}" must be 1 to 32 lowercase ASCII letters, digits, ".", "_" or "-", beginning with a letter or digit.`,
      "invalid-server-name",
    );
  }

  const firstSegment = serverName.split(".", 1)[0]!;
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(firstSegment)) {
    throw new InvalidServerConfigError(
      `MCP server name "${serverName}" uses the Windows-reserved device name "${firstSegment}".`,
      "invalid-server-name",
    );
  }
}

function parseConnectionMode(value: unknown, serverName: string): ServerConnectionMode {
  if (value === undefined) {
    return DEFAULT_CONNECTION_MODE;
  }

  if (value !== "lazy" && value !== "eager") {
    invalid(`Server "${serverName}" connectionMode must be "lazy" or "eager".`, "connectionMode");
  }

  return value;
}

function parseOverviewPath(value: unknown, serverName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`Server "${serverName}" overview must be a non-empty absolute path.`, "overview");
  }

  if (!isAbsolute(value)) {
    invalid(
      `Server "${serverName}" overview must be an absolute path after host configuration resolution.`,
      "overview",
    );
  }

  return value;
}

function parseRequiredString(
  value: unknown,
  fieldName: string,
  serverName: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`Server "${serverName}" must provide a non-empty ${fieldName}.`, fieldName);
  }
  return value;
}

function parseOptionalString(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): string | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`Server "${serverName}" field "${fieldName}" must be a non-empty string.`, fieldName);
  }
  return value;
}

function parseOptionalStringArray(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): string[] | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    invalid(`Server "${serverName}" field "${fieldName}" must be an array of strings.`, fieldName);
  }
  return [...value];
}

function parseOptionalStringRecord(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): Record<string, string> | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value) || Object.values(value).some(item => typeof item !== "string")) {
    invalid(`Server "${serverName}" field "${fieldName}" must be an object of string values.`, fieldName);
  }
  return { ...value } as Record<string, string>;
}

function parseToolNameList(
  definition: ServerDefinition,
  fieldName: "includeTools" | "excludeTools",
  serverName: string,
): string[] {
  const value = definition[fieldName];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    invalid(`Server "${serverName}" field "${fieldName}" must be an array of non-empty strings.`, fieldName);
  }

  return [...value];
}

function parseToolFilter(definition: ServerDefinition, serverName: string): ResolvedToolFilter {
  return {
    include: parseToolNameList(definition, "includeTools", serverName),
    exclude: parseToolNameList(definition, "excludeTools", serverName),
  };
}

function parseUrl(
  value: unknown,
  fieldName: "url" | "oauth.clientMetadataUrl",
  serverName: string,
  protocol: "http" | "https" | "http-or-https",
): URL {
  const text = parseRequiredString(value, fieldName, serverName);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    invalid(`Server "${serverName}" ${fieldName} must be a valid URL.`, fieldName);
  }

  const allowed = protocol === "http-or-https"
    ? url.protocol === "http:" || url.protocol === "https:"
    : url.protocol === `${protocol}:`;
  if (!allowed) {
    const protocolMessage = protocol === "http-or-https" ? "http or https" : protocol;
    invalid(`Server "${serverName}" ${fieldName} must use ${protocolMessage}.`, fieldName);
  }

  return url;
}

function parseOauthConfig(
  definition: ServerDefinition,
  serverName: string,
): ResolvedOauthConfig {
  const rawOauth = definition.oauth;
  if (rawOauth !== undefined && !isObject(rawOauth)) {
    invalid(`Server "${serverName}" oauth must be an object.`, "oauth");
  }

  const oauth = (rawOauth ?? {}) as Record<string, unknown>;
  const clientMetadataValue = oauth.clientMetadataUrl;
  let clientMetadataUrl: string | undefined;
  if (clientMetadataValue !== undefined) {
    const clientMetadata = parseUrl(
      clientMetadataValue,
      "oauth.clientMetadataUrl",
      serverName,
      "https",
    );
    if (clientMetadata.pathname === "/") {
      invalid(
        `Server "${serverName}" oauth.clientMetadataUrl must be an HTTPS URL with a non-root path.`,
        "oauth.clientMetadataUrl",
      );
    }
    clientMetadataUrl = clientMetadata.toString();
  }

  let scope: string | undefined;
  if (oauth.scope !== undefined) {
    if (typeof oauth.scope !== "string" || oauth.scope.trim().length === 0) {
      invalid(`Server "${serverName}" oauth.scope must be a non-empty string.`, "oauth.scope");
    }
    scope = oauth.scope.trim();
  }

  let profile = "default";
  if (oauth.profile !== undefined) {
    if (typeof oauth.profile !== "string" || oauth.profile.trim().length === 0) {
      invalid(`Server "${serverName}" oauth.profile must be a non-empty string.`, "oauth.profile");
    }
    profile = oauth.profile.trim();
  }

  return {
    ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
    ...(scope === undefined ? {} : { scope }),
    profile,
  };
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return headers !== undefined
    && Object.keys(headers).some(name => name.toLowerCase() === "authorization");
}

function parseHttpTransport(
  definition: ServerDefinition,
  serverName: string,
): ResolvedHttpTransport {
  const headers = parseOptionalStringRecord(definition, "headers", serverName);
  const bearerToken = parseOptionalString(definition, "bearerToken", serverName);
  const auth = definition.auth;
  const rawOauth = definition.oauth;

  if (auth !== undefined && auth !== "oauth") {
    invalid(`Server "${serverName}" auth must be "oauth" when provided.`, "auth");
  }

  if (auth === undefined && rawOauth !== undefined) {
    invalid(`Server "${serverName}" provides oauth settings but auth is not "oauth".`, "oauth");
  }

  const url = parseUrl(definition.url, "url", serverName, "http-or-https");

  if (auth === "oauth") {
    if (bearerToken !== undefined) {
      invalid(`Server "${serverName}" cannot combine auth "oauth" with bearerToken.`, "bearerToken");
    }
    if (hasAuthorizationHeader(headers)) {
      invalid(`Server "${serverName}" cannot combine auth "oauth" with headers.Authorization.`, "headers");
    }

    return {
      kind: "http",
      url,
      auth: "oauth",
      ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
      oauth: parseOauthConfig(definition, serverName),
    };
  }

  const isStatic = bearerToken !== undefined || (headers !== undefined && Object.keys(headers).length > 0);
  return {
    kind: "http",
    url,
    auth: isStatic ? "static" : "public",
    ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(bearerToken === undefined ? {} : { bearerToken }),
  };
}

function parseStdioTransport(
  definition: ServerDefinition,
  serverName: string,
): ResolvedStdioTransport {
  if (definition.auth !== undefined) {
    invalid(`Server "${serverName}" auth is only supported for HTTP servers.`, "auth");
  }
  if (definition.oauth !== undefined) {
    invalid(`Server "${serverName}" oauth settings require HTTP transport.`, "oauth");
  }

  const command = parseRequiredString(definition.command, "command", serverName);
  const args = parseOptionalStringArray(definition, "args", serverName);
  const cwd = parseOptionalString(definition, "cwd", serverName);
  const env = parseOptionalStringRecord(definition, "env", serverName);

  return {
    kind: "stdio",
    command,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  };
}

function parseTransport(
  definition: ServerDefinition,
  serverName: string,
): ResolvedServerTransport {
  const explicitTransport = definition.transport;
  if (explicitTransport !== undefined && explicitTransport !== "stdio" && explicitTransport !== "http") {
    invalid(`Server "${serverName}" transport must be "stdio" or "http" when provided.`, "transport");
  }

  let transport = explicitTransport as "stdio" | "http" | undefined;
  if (transport === undefined) {
    const hasCommand = definition.command !== undefined;
    const hasUrl = definition.url !== undefined;

    if (hasCommand && hasUrl) {
      invalid(`Server "${serverName}" has both command and url; set transport explicitly or remove one of them.`, "transport");
    }
    if (!hasCommand && !hasUrl) {
      invalid(`Server "${serverName}" must provide command or url, or set transport to "stdio" or "http".`, "transport");
    }

    transport = hasCommand ? "stdio" : "http";
  }

  return transport === "stdio"
    ? parseStdioTransport(definition, serverName)
    : parseHttpTransport(definition, serverName);
}

export function parseServerConfig(
  serverName: string,
  raw: unknown,
): ParsedServerConfig {
  if (!isObject(raw)) {
    invalid(`Server "${serverName}" config must be an object.`);
  }

  return {
    connectionMode: parseConnectionMode(raw.connectionMode, serverName),
    configuredOverviewPath: parseOverviewPath(raw.overview, serverName),
    transport: parseTransport(raw, serverName),
    toolFilter: parseToolFilter(raw, serverName),
  };
}

export function toResolvedServerConfig(
  name: string,
  parsed: ParsedServerConfig,
  overview: ResolvedServerConfig["overview"],
): ResolvedServerConfig {
  return {
    name,
    connectionMode: parsed.connectionMode,
    ...(parsed.configuredOverviewPath === undefined
      ? {}
      : { configuredOverviewPath: parsed.configuredOverviewPath }),
    overview,
    transport: parsed.transport,
    toolFilter: parsed.toolFilter,
  };
}
