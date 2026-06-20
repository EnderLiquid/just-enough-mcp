import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMcpRuntime } from "./clients/runtime.js";
import { loadPluginConfig } from "./config/plugin-config.js";
import { createServerOverviewPrompt } from "./prompting/system-prompt.js";
import { registerMcpTool } from "./tools/mcp-tool.js";

const STATUS_KEY = "just-enough-mcp";

export default function justEnoughMcp(pi: ExtensionAPI): void {
  registerMcpTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    const runtime = getMcpRuntime();
    try {
      await runtime.sync();
      runtime.refreshFooter(ctx);
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`just-enough-mcp config error: ${message}`, "error");
        ctx.ui.setStatus(STATUS_KEY, "0/0 MCP");
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    try {
      const config = loadPluginConfig();
      const injectedPrompt = createServerOverviewPrompt(config);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## MCP Servers\n\n${injectedPrompt}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n## MCP Servers\n\n` +
          `just-enough-mcp could not load its configuration: ${message}`,
      };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const runtime = getMcpRuntime();
    await runtime.closeAll();
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
