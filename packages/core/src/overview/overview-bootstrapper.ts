import { tryBootstrapOverviewFromDescription, type OverviewBootstrapResult } from "./overview-bootstrap.js";
import type { ServerDescriptionReadyEvent } from "../servers/servers/types.js";

export interface OverviewBootstrapperOptions {
  overviewDirectoryPath: string;
  onCreated?: (serverName: string) => void;
  bootstrap?: (
    event: ServerDescriptionReadyEvent,
    overviewDirectoryPath: string,
  ) => Promise<OverviewBootstrapResult | undefined>;
}

export class OverviewBootstrapper {
  private accepting = true;
  private closePromise: Promise<void> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly bootstrap: NonNullable<OverviewBootstrapperOptions["bootstrap"]>;

  constructor(private readonly options: OverviewBootstrapperOptions) {
    this.bootstrap = options.bootstrap ?? ((event, overviewDirectoryPath) =>
      tryBootstrapOverviewFromDescription(event.config, overviewDirectoryPath, event.description));
  }

  notify(event: ServerDescriptionReadyEvent): void {
    if (!this.accepting || event.description.trim().length === 0) {
      return;
    }

    const task = Promise.resolve()
      .then(() => this.bootstrap(event, this.options.overviewDirectoryPath))
      .then((result) => {
        if (result?.created) {
          this.options.onCreated?.(event.config.name);
        }
      })
      .catch(() => {});

    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  close(): Promise<void> {
    this.accepting = false;
    this.closePromise ??= this.drain();
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}
