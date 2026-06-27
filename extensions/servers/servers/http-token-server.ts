import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedServerConfig, ServerSnapshot } from "../../modeling/types.js";
import { ConnectedSdkServer } from "./connected-sdk-server.js";
import { expectNonEmptyString, expectOptionalString, expectOptionalStringRecord, expectTransport } from "./config-helpers.js";

const PROFILE = "http-tools-token";

export class HttpTokenServer extends ConnectedSdkServer {
  private readonly url: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly bearerToken: string | undefined;

  constructor(config: ResolvedServerConfig) {
    super(config, PROFILE);
    expectTransport(config.definition, config.name, "http", PROFILE);
    this.url = expectNonEmptyString(config.definition, "url", config.name, PROFILE);
    this.headers = expectOptionalStringRecord(config.definition, "headers", config.name);
    this.bearerToken = expectOptionalString(config.definition, "bearerToken", config.name);
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      profile: PROFILE,
      connectState: this.connectState,
      tools: this.tools,
    };
  }

  protected createTransport(): Transport {
    const headers = { ...(this.headers ?? {}) };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }

    return new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
  }
}
