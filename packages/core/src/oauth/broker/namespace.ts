import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const OAUTH_BROKER_NAMESPACE_VERSION = 1 as const;

export interface OAuthBrokerNamespace {
  readonly namespaceVersion: typeof OAUTH_BROKER_NAMESPACE_VERSION;
  readonly namespaceId: `agent-dir:v1:${string}`;
  /** 仅供本机路径解析，不写入 endpoint、日志或 API。 */
  readonly canonicalAgentDir: string;
}

export async function createOAuthBrokerNamespace(
  agentDir: string,
): Promise<OAuthBrokerNamespace> {
  if (typeof agentDir !== "string" || agentDir.trim().length === 0) {
    throw new TypeError("agentDir must be a non-empty string.");
  }

  const absolute = resolve(agentDir);
  await mkdir(absolute, { recursive: true });
  const resolved = await realpath(absolute);
  const canonicalAgentDir = process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
  const digest = createHash("sha256")
    .update(JSON.stringify({
      namespaceVersion: OAUTH_BROKER_NAMESPACE_VERSION,
      canonicalAgentDir,
    }), "utf8")
    .digest("hex");

  return {
    namespaceVersion: OAUTH_BROKER_NAMESPACE_VERSION,
    namespaceId: `agent-dir:v1:${digest}`,
    canonicalAgentDir,
  };
}
