import type { ServerRegistry } from "../servers/registry.js";

const STATUS_KEY = "just-enough-mcp";

export interface FooterStatusSink {
  setStatus(key: string, text: string | undefined): void;
}

let currentFooterStatusSink: FooterStatusSink | undefined;

export function installFooterStatusSink(sink?: FooterStatusSink): () => void {
  currentFooterStatusSink = sink;

  return () => {
    if (currentFooterStatusSink !== sink) {
      return;
    }

    try {
      sink?.setStatus(STATUS_KEY, undefined);
    } finally {
      currentFooterStatusSink = undefined;
    }
  };
}

export function updateFooterStatus(connectedServers: number, totalServers: number): void {
  currentFooterStatusSink?.setStatus(STATUS_KEY, `${connectedServers}/${totalServers} MCP`);
}

export async function refreshFooterStatus(
  registry: Pick<ServerRegistry, "getStatus">,
): Promise<void> {
  const current = await registry.getStatus();
  updateFooterStatus(current.connectedCount, current.totalCount);
}
