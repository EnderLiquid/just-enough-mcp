import type { ServerSnapshot } from "../../modeling/types.js";
import { SdkBackedServer } from "./sdk-server.js";

export class HttpTokenServer extends SdkBackedServer {
  snapshot(): ServerSnapshot {
    return {
      name: this.name,
      profile: "http-tools-token",
      tools: this.tools,
    };
  }

  protected async connectFresh(): Promise<ServerSnapshot> {
    await this.openDriver();
    return this.snapshot();
  }
}
