import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedServerConfig, ServerSnapshot } from "../../modeling/types.js";
import { ConnectedSdkServer } from "./connected-sdk-server.js";
import { expectNonEmptyString, expectOptionalTransport } from "./config-helpers.js";

const PROFILE = "http-tools-public";

export class HttpPublicServer extends ConnectedSdkServer {
  private readonly url: string;

  constructor(config: ResolvedServerConfig) {
    super(config, PROFILE);
    expectOptionalTransport(config.definition, config.name, "http", PROFILE);
    this.url = expectNonEmptyString(config.definition, "url", config.name, PROFILE);
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
    return new StreamableHTTPClientTransport(new URL(this.url));
  }
}
