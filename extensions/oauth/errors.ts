export class OauthAuthorizationRequiredError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" requires OAuth authorization. Run mcp_server with action "authorize" for this server, then retry the requested operation.`);
    this.name = "OauthAuthorizationRequiredError";
  }
}
