import type { Theme } from "@earendil-works/pi-coding-agent";
import type { McpRegistryStatus } from "../servers/registry.js";

const STATUS_KEY = "just-enough-mcp";

export interface FooterStatusSink {
  setStatus(key: string, text: string | undefined): void;
  readonly theme: Pick<Theme, "fg">;
}

export interface FooterStatusController {
  refresh(status?: McpRegistryStatus): void;
  dispose(): void;
}

export function createFooterStatusController(
  sink?: FooterStatusSink,
): FooterStatusController {
  let disposed = false;

  return {
    refresh(status) {
      if (disposed || !sink) {
        return;
      }

      const text = status
        ? sink.theme.fg("dim", `${status.connectedCount}/${status.totalCount} MCP`)
        : undefined;
      sink.setStatus(STATUS_KEY, text);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        sink?.setStatus(STATUS_KEY, undefined);
      } catch {}
    },
  };
}
