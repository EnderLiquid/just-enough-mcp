import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedServerConfig, ServerSnapshot } from "../../modeling/types.js";
import { ConnectedSdkServer } from "./connected-sdk-server.js";
import { expectNonEmptyString, expectOptionalString, expectOptionalStringArray, expectOptionalStringRecord, expectOptionalTransport } from "./config-helpers.js";

const PROFILE = "stdio-tools-pragmatic";

export class StdioPragmaticServer extends ConnectedSdkServer {
  private readonly command: string;
  private readonly args: string[] | undefined;
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;

  constructor(config: ResolvedServerConfig) {
    super(config, PROFILE);
    expectOptionalTransport(config.definition, config.name, "stdio", PROFILE);
    this.command = expectNonEmptyString(config.definition, "command", config.name, PROFILE);
    this.args = expectOptionalStringArray(config.definition, "args", config.name);
    this.cwd = expectOptionalString(config.definition, "cwd", config.name);
    this.env = expectOptionalStringRecord(config.definition, "env", config.name);
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
    return new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
      stderr: "ignore",
    });
  }
}
