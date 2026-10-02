import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { McpRegistry } from "../packages/core/src/servers/registry.js";
import { createMcpTool, type McpToolRuntime } from "../packages/pi-adapter/src/tools/mcp-tool.js";
import { makeServerSnapshot } from "./support/model-fixtures.js";
import { createTempDirFixture } from "./support/temp-dir.js";

const tempDirs = createTempDirFixture("jem-codemode");

afterEach(() => {
  tempDirs.cleanup();
});

interface FakePiRuntime {
  tools: AgentTool[];
  pi: ExtensionAPI;
}

function createFakePiRuntime(): FakePiRuntime {
  const tools: AgentTool[] = [];
  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool as AgentTool);
    },
    appendEntry() {},
    getAllTools() {
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    },
  } as unknown as ExtensionAPI;

  return { tools, pi };
}

function createCodemodeContext(tools: AgentTool[]): ExtensionToolContext {
  let callIndex = 0;
  const context = {
    tools,
    sessionManager: {
      getBranch: () => [],
    },
    async executeTool(
      name: string,
      args: unknown,
      options?: { signal?: AbortSignal; onUpdate?: (result: unknown) => void },
    ): Promise<AgentToolCallOutcome> {
      const tool = tools.find(candidate => candidate.name === name);
      if (!tool) {
        throw new Error(`Unknown test tool: ${name}`);
      }

      const toolCallId = `codemode-test/${++callIndex}`;
      const result = await tool.execute(
        toolCallId,
        args,
        options?.signal,
        options?.onUpdate,
      );
      return {
        toolCall: {
          type: "toolCall",
          id: toolCallId,
          name,
          arguments: args,
        },
        result,
        isError: result.isError === true,
      } as AgentToolCallOutcome;
    },
  } as unknown as ExtensionToolContext;

  return context;
}

function createMcpToolForCodemode(input: {
  artifactDir: string;
  isError?: boolean;
  includeImage?: boolean;
}): {
  tool: AgentTool;
  getServerCatalog: () => Promise<unknown>;
  callTool: () => Promise<unknown>;
} {
  let catalogCalls = 0;
  let callCalls = 0;
  const getServerCatalog = async () => {
    catalogCalls++;
    return {
      server: makeServerSnapshot({ name: "demo" }),
      tools: [{
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      }],
    };
  };
  const callTool = async () => {
    callCalls++;
    return {
      server: makeServerSnapshot({ name: "demo" }),
      toolName: "lookup",
      args: { id: "42" },
      result: {
        content: [
          { type: "text", text: JSON.stringify({ answer: 42 }) },
          ...(input.includeImage
            ? [{ type: "image" as const, mimeType: "image/png", data: Buffer.from("png").toString("base64") }]
            : []),
        ],
        ...(input.isError ? { isError: true } : {}),
      },
    };
  };
  const registry = {
    getServerCatalog,
    callTool,
    getStatus: async () => ({ servers: [], connectedCount: 0, totalCount: 0 }),
  } as unknown as McpRegistry;
  const runtime: McpToolRuntime = {
    getRegistry: () => registry,
    getArtifactDir: () => input.artifactDir,
    getMaterializationSettings: () => undefined,
    getTuiSettings: () => undefined,
    refreshFooterStatus: () => {},
  };

  return {
    tool: createMcpTool(runtime) as unknown as AgentTool,
    getServerCatalog: async () => {
      await Promise.resolve();
      return catalogCalls;
    },
    callTool: async () => {
      await Promise.resolve();
      return callCalls;
    },
  };
}

async function executeCodemodeWithMcpTool(input: { isError?: boolean; includeImage?: boolean } = {}) {
  const artifactDir = tempDirs.create();
  const mcp = createMcpToolForCodemode({
    artifactDir,
    isError: input.isError,
    includeImage: input.includeImage,
  });
  const fakePi = createFakePiRuntime();
  createCodemodeExtension({ models: false, mode: "on" })(fakePi.pi);

  const codemodeTool = fakePi.tools.find(tool => tool.name === "codemode") as unknown as ToolDefinition;
  if (!codemodeTool) {
    throw new Error("codemode tool was not registered");
  }

  const context = createCodemodeContext([mcp.tool]);
  const result = await codemodeTool.execute(
    "codemode-test",
    {
      code: `
        const catalog = await tools.mcp_tool({ action: "list", server: "demo" });
        const selected = catalog.tools.find(tool => tool.name === "lookup");
        const call = await tools.mcp_tool({
          action: "call",
          server: "demo",
          tool: selected.name,
          args: { id: "42" },
        });
        const image = call.payloadItems.find(item => item.contentType === "image");
        return {
          kind: call.kind,
          answer: call.payloadItems[0].parsedJson.answer,
          image: image?.binaryBase64,
          isError: call.isError,
          hasSummaryText: Object.prototype.hasOwnProperty.call(call, "summaryText"),
          hasPreview: Object.prototype.hasOwnProperty.call(call.payloadItems[0], "preview"),
        };
      `,
    },
    undefined,
    undefined,
    context,
  );

  return { result, mcp };
}

describe("Pi 0.99.2 codemode mcp_tool 代理", () => {
  it("在同一脚本中完成 list -> call，并直接读取 parsedJson", async () => {
    const { result, mcp } = await executeCodemodeWithMcpTool({ includeImage: true });
    const output = result.content.map(item => item.type === "text" ? item.text : "").join("\n");

    expect(result.isError).not.toBe(true);
    expect(output).toContain('"kind":"call"');
    expect(output).toContain('"answer":42');
    expect(output).toContain('"image":"cG5n"');
    expect(output).toContain('"isError":false');
    expect(output).toContain('"hasSummaryText":false');
    expect(output).toContain('"hasPreview":false');
    expect(await mcp.getServerCatalog()).toBe(1);
    expect(await mcp.callTool()).toBe(1);
  });

  it("业务失败仍由 structuredContent 传回脚本", async () => {
    const { result } = await executeCodemodeWithMcpTool({ isError: true });
    const output = result.content.map(item => item.type === "text" ? item.text : "").join("\n");

    expect(result.isError).not.toBe(true);
    expect(output).toContain('"answer":42');
    expect(output).toContain('"isError":true');
    expect(output).toContain('"hasSummaryText":false');
    expect(output).toContain('"hasPreview":false');
  });
});
