import type { ResolvedServerSpec } from "../../modeling/types.js";
import { HttpSdkDriver } from "./http-sdk-driver.js";
import { StdioSdkDriver } from "./stdio-sdk-driver.js";
import type { ServerDriver } from "./types.js";

export function createServerDriver(spec: ResolvedServerSpec): ServerDriver {
  switch (spec.initialProfileId) {
    case "stdio-tools-pragmatic": {
      if (spec.transport !== "stdio") {
        throw new Error(`Profile ${spec.initialProfileId} is incompatible with transport ${spec.transport} for server ${spec.name}`);
      }
      return new StdioSdkDriver(spec);
    }
    case "http-tools-public":
    case "http-tools-token": {
      if (spec.transport !== "http") {
        throw new Error(`Profile ${spec.initialProfileId} is incompatible with transport ${spec.transport} for server ${spec.name}`);
      }
      return new HttpSdkDriver(spec);
    }
    default: {
      const exhaustiveCheck: never = spec.initialProfileId;
      throw new Error(`Unsupported compatibility profile: ${exhaustiveCheck}`);
    }
  }
}
