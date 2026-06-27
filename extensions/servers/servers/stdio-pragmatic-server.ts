import type { ServerConnectState, ServerSnapshot } from "../../modeling/types.js";
import { SdkBackedServer } from "./sdk-server.js";

export class StdioPragmaticServer extends SdkBackedServer {
  private connectState: ServerConnectState = "disconnected";

  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      profile: "stdio-tools-pragmatic",
      connectState: this.connectState,
      tools: this.tools,
    };
  }

  async close(): Promise<void> {
    await super.close();
    this.connectState = "disconnected";
  }

  protected async connectFresh(): Promise<ServerSnapshot> {
    this.connectState = "connecting";
    try {
      await this.openDriver();
      this.connectState = "connected";
      return this.snapshot();
    } catch (error) {
      this.connectState = "disconnected";
      throw error;
    }
  }
}
