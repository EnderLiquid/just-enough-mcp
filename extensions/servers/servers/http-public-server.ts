import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedServerSpec, ServerSnapshot, ServerTransportConfig } from "../../modeling/types.js";
import { ConnectedSdkServer } from "./connected-sdk-server.js";

type HttpResolvedServerSpec = Extract<ResolvedServerSpec, ServerTransportConfig & { transport: "http" }>;

export class HttpPublicServer extends ConnectedSdkServer {
  constructor(readonly spec: HttpResolvedServerSpec) {
    super(spec);
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      profile: "http-tools-public",
      connectState: this.connectState,
      tools: this.tools,
    };
  }

  protected createTransport(): Transport {
    return new StreamableHTTPClientTransport(new URL(this.spec.url));
  }
}
