import type { PayloadContentType } from "../../core/artifacts/types.js";
import type { ServerCatalogResult, ServerConnectState, ServerOauthState } from "../../core/modeling/types.js";

export type McpServerResultDetails =
  | { kind: "status"; connectedCount: number; totalCount: number }
  | { kind: "status"; serverName: string; connectState: ServerConnectState; oauthState?: ServerOauthState }
  | { kind: "connect" }
  | { kind: "disconnect" }
  | { kind: "authorize" }
  | { kind: "logout" };

export interface McpToolStructuredPayloadItem {
  index: number;
  source: string;
  contentType?: PayloadContentType;
  mimeType: string;
  rawMimeType?: string;
  uri?: string;
  description?: string;
  text?: string;
  binaryBase64?: string;
  parsedJson?: unknown;
  path: string;
  fileName: string;
}

export type McpToolStructuredContent =
  | {
      kind: "catalog";
      server: string;
      tools: ServerCatalogResult["tools"];
    }
  | {
      kind: "call";
      server: string;
      tool: string;
      payloadItems: McpToolStructuredPayloadItem[];
      manifestPath: string;
      isError: boolean;
    };

export type McpToolResultDetails =
  | { kind: "list"; toolCount: number }
  | { kind: "call"; payloadItemCount: number; outcome: "success" | "error" };
