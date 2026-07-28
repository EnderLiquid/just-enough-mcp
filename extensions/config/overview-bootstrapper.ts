import { tryBootstrapOverviewFromDescription, type OverviewBootstrapResult } from "./overview-bootstrap.js";
import type { ServerDescriptionReadyEvent } from "../servers/servers/types.js";

export interface OverviewBootstrapper {
  notify(event: ServerDescriptionReadyEvent): void;
  close(): Promise<void>;
}

export interface OverviewBootstrapperOptions {
  overviewDir: string;
  onCreated?: (serverName: string) => void;
  bootstrap?: (
    event: ServerDescriptionReadyEvent,
    overviewDir: string,
  ) => Promise<OverviewBootstrapResult | undefined>;
}

let currentOverviewBootstrapper: OverviewBootstrapper | undefined;

export function installCurrentOverviewBootstrapper(
  bootstrapper: OverviewBootstrapper,
): () => void {
  currentOverviewBootstrapper = bootstrapper;

  return () => {
    if (currentOverviewBootstrapper === bootstrapper) {
      currentOverviewBootstrapper = undefined;
    }
  };
}

export function notifyServerDescriptionReady(event: ServerDescriptionReadyEvent): void {
  try {
    currentOverviewBootstrapper?.notify(event);
  } catch {
  }
}

export function createOverviewBootstrapper(
  options: OverviewBootstrapperOptions,
): OverviewBootstrapper {
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const bootstrap = options.bootstrap ?? ((event, overviewDir) =>
    tryBootstrapOverviewFromDescription(event.config, overviewDir, event.description));

  function notify(event: ServerDescriptionReadyEvent): void {
    if (!accepting || event.description.trim().length === 0) {
      return;
    }

    const task = Promise.resolve()
      .then(() => bootstrap(event, options.overviewDir))
      .then((result) => {
        if (result?.created) {
          options.onCreated?.(event.config.name);
        }
      })
      .catch(() => {});

    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  }

  return {
    notify,
    close() {
      accepting = false;
      closePromise ??= drain();
      return closePromise;
    },
  };
}
