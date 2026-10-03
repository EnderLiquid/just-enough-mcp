import type { ResolvedServerConfig } from "../../modeling/types.js";
import type { OverviewBootstrapper } from "../../overview/overview-bootstrapper.js";
import {
  OauthHttpServer,
  type OauthHttpServerDependencies,
} from "./oauth-http-server.js";
import { HttpPublicServer } from "./http-public-server.js";
import { HttpTokenServer } from "./http-token-server.js";
import { StdioPragmaticServer } from "./stdio-pragmatic-server.js";
import type { McpServer } from "./types.js";

interface McpServerConstructionDependencies {
  readonly oauth?: OauthHttpServerDependencies;
  readonly overviewBootstrapper?: OverviewBootstrapper;
}

export function createMcpServer(
  config: ResolvedServerConfig,
  dependencies: McpServerConstructionDependencies = {},
): McpServer {
  switch (config.transport.kind) {
    case "stdio":
      return new StdioPragmaticServer(config, dependencies.overviewBootstrapper);
    case "http":
      switch (config.transport.auth) {
        case "oauth":
          return new OauthHttpServer(
            config,
            dependencies.oauth,
            dependencies.overviewBootstrapper,
          );
        case "static":
          return new HttpTokenServer(config, dependencies.overviewBootstrapper);
        case "public":
          return new HttpPublicServer(config, dependencies.overviewBootstrapper);
      }
  }
}
