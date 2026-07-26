import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMcpRuntime } from "./servers/runtime.js";
import { createServerOverviewPrompt } from "./prompting/system-prompt.js";
import { registerMcpServerTool } from "./tools/mcp-server-tool.js";
import { registerMcpTool } from "./tools/mcp-tool.js";
import { clearFooterStatus, setFooterStatusSink, updateFooterStatus } from "./rendering/footer-status.js";
import { clearNotifier, notifyError, setNotifier } from "./rendering/notifier.js";

export default function justEnoughMcp(pi: ExtensionAPI): void {
  registerMcpServerTool(pi);
  registerMcpTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    const runtime = getMcpRuntime();
    setNotifier(ctx.hasUI ? { notify: ctx.ui.notify.bind(ctx.ui) } : undefined);
    setFooterStatusSink(ctx.hasUI ? { setStatus: ctx.ui.setStatus.bind(ctx.ui) } : undefined);
    try {
      await runtime.sync();
      await runtime.refreshFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyError(`just-enough-mcp config error: ${message}`);
      updateFooterStatus(0, 0);
    }
  });

  pi.on("before_agent_start", async (event) => {
    const runtime = getMcpRuntime();
    const config = runtime.config();

    if (!config) {
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n# MCP Servers\n\n` +
          "just-enough-mcp has not loaded its configuration for this session yet. Use /reload if needed.",
      };
    }

    const injectedPrompt = createServerOverviewPrompt(config);
    return {
      systemPrompt: `${event.systemPrompt}\n\n# MCP Servers\n\n${injectedPrompt}`,
    };
  });

  pi.on("session_shutdown", async () => {
    const runtime = getMcpRuntime();
    clearNotifier();
    try {
      await runtime.closeAll();
    } finally {
      clearFooterStatus();
    }
  });
}
