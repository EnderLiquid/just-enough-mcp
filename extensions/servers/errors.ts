export type McpRegistryErrorCode =
  | "registry-closed"
  | "unknown-server"
  | "unsupported-capability";

export interface McpRegistryErrorDetails {
  readonly [key: string]: string;
}

export interface SerializedMcpRegistryError {
  name: string;
  code: McpRegistryErrorCode;
  message: string;
  details: McpRegistryErrorDetails;
}

export class McpRegistryError extends Error {
  readonly code: McpRegistryErrorCode;
  readonly details: McpRegistryErrorDetails;

  constructor(
    code: McpRegistryErrorCode,
    message: string,
    details: McpRegistryErrorDetails = {},
  ) {
    super(message);
    this.name = "McpRegistryError";
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedMcpRegistryError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class RegistryClosedError extends McpRegistryError {
  constructor() {
    super("registry-closed", "MCP server registry is closed.");
    this.name = "RegistryClosedError";
  }
}

export class UnknownServerError extends McpRegistryError {
  readonly serverName: string;

  constructor(serverName: string) {
    super(
      "unknown-server",
      `Unknown MCP server: ${serverName}`,
      { serverName },
    );
    this.name = "UnknownServerError";
    this.serverName = serverName;
  }
}

export type UnsupportedServerCapability = "oauth-authorization" | "oauth-logout";

export class UnsupportedServerCapabilityError extends McpRegistryError {
  readonly serverName: string;
  readonly capability: UnsupportedServerCapability;

  constructor(serverName: string, capability: UnsupportedServerCapability) {
    const message = capability === "oauth-authorization"
      ? `MCP server "${serverName}" does not support OAuth authorization.`
      : `MCP server "${serverName}" does not support OAuth logout.`;
    super("unsupported-capability", message, { serverName, capability });
    this.name = "UnsupportedServerCapabilityError";
    this.serverName = serverName;
    this.capability = capability;
  }
}
