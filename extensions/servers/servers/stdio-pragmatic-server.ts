import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedServerSpec, ServerSnapshot, ServerTransportConfig } from "../../modeling/types.js";
import { ConnectedSdkServer } from "./connected-sdk-server.js";

type StdioResolvedServerSpec = Extract<ResolvedServerSpec, ServerTransportConfig & { transport: "stdio" }>;

export class StdioPragmaticServer extends ConnectedSdkServer {
  constructor(readonly spec: StdioResolvedServerSpec) {
    super(spec);
  }

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      profile: "stdio-tools-pragmatic",
      connectState: this.connectState,
      tools: this.tools,
    };
  }

  protected createTransport(): Transport {
    return new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args,
      cwd: this.spec.cwd,
      env: this.spec.env,
      stderr: "ignore",
    });
  }
}
