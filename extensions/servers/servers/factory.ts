import type { ResolvedServerSpec } from "../../modeling/types.js";
import { HttpPublicServer } from "./http-public-server.js";
import { HttpTokenServer } from "./http-token-server.js";
import { StdioPragmaticServer } from "./stdio-pragmatic-server.js";
import type { McpServer } from "./types.js";

export function createMcpServer(spec: ResolvedServerSpec): McpServer {
  switch (spec.profile) {
    case "stdio-tools-pragmatic": {
      if (spec.transport !== "stdio") {
        throw new Error(`Profile ${spec.profile} is incompatible with transport ${spec.transport} for server ${spec.name}`);
      }
      return new StdioPragmaticServer(spec);
    }
    case "http-tools-public": {
      if (spec.transport !== "http") {
        throw new Error(`Profile ${spec.profile} is incompatible with transport ${spec.transport} for server ${spec.name}`);
      }
      return new HttpPublicServer(spec);
    }
    case "http-tools-token": {
      if (spec.transport !== "http") {
        throw new Error(`Profile ${spec.profile} is incompatible with transport ${spec.transport} for server ${spec.name}`);
      }
      return new HttpTokenServer(spec);
    }
    default: {
      const exhaustiveCheck: never = spec.profile;
      throw new Error(`Unsupported compatibility profile: ${exhaustiveCheck}`);
    }
  }
}
