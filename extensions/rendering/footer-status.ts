const STATUS_KEY = "just-enough-mcp";

export interface FooterStatusSink {
  setStatus(key: string, text: string | undefined): void;
}

let currentFooterStatusSink: FooterStatusSink | undefined;

export function setFooterStatusSink(sink?: FooterStatusSink): void {
  currentFooterStatusSink = sink;
}

export function updateFooterStatus(connectedServers: number, totalServers: number): void {
  currentFooterStatusSink?.setStatus(STATUS_KEY, `${connectedServers}/${totalServers} MCP`);
}

export function clearFooterStatus(): void {
  try {
    currentFooterStatusSink?.setStatus(STATUS_KEY, undefined);
  } finally {
    currentFooterStatusSink = undefined;
  }
}
