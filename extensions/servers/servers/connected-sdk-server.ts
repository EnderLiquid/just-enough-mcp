import type { ServerConnectState, ServerSnapshot } from "../../modeling/types.js";
import { SdkBackedServer } from "./sdk-server.js";

export abstract class ConnectedSdkServer extends SdkBackedServer {
  protected connectState: ServerConnectState = "disconnected";
  private connectPromise: Promise<ServerSnapshot> | undefined;

  async connect(signal?: AbortSignal): Promise<ServerSnapshot> {
    if (this.client) {
      return this.snapshot();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectFresh(signal);
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async close(): Promise<void> {
    await super.close();
    this.connectState = "disconnected";
  }

  private async connectFresh(signal?: AbortSignal): Promise<ServerSnapshot> {
    this.connectState = "connecting";
    try {
      await this.openClient(signal);
      this.connectState = "connected";
      return this.snapshot();
    } catch (error) {
      this.connectState = "disconnected";
      throw error;
    }
  }
}
