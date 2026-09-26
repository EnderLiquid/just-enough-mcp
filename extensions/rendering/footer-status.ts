import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ServerRegistryStatus } from "../servers/registry.js";

const STATUS_KEY = "just-enough-mcp";

export interface FooterStatusSink {
  setStatus(key: string, text: string | undefined): void;
  readonly theme: Pick<Theme, "fg">;
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

export function refreshFooterStatus(status?: ServerRegistryStatus): void {
  const sink = currentFooterStatusSink;
  if (!sink) {
    return;
  }

  const text = status
    ? sink.theme.fg("dim", `${status.connectedCount}/${status.totalCount} MCP`)
    : undefined;
  sink.setStatus(STATUS_KEY, text);
}
