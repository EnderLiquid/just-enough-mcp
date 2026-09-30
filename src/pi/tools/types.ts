import type { ServerConnectState, ServerOauthState } from "../../core/modeling/types.js";

export type McpServerResultDetails =
  | { kind: "status"; connectedCount: number; totalCount: number }
  | { kind: "status"; serverName: string; connectState: ServerConnectState; oauthState?: ServerOauthState }
  | { kind: "connect" }
  | { kind: "disconnect" }
  | { kind: "authorize" }
  | { kind: "logout" };

export type McpToolResultDetails =
  | { kind: "list"; toolCount: number }
  | { kind: "call"; payloadItemCount: number; outcome: "success" | "error" };
