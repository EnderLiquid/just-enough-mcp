import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerSpec, ServerCatalogResult, ServerSnapshot, ToolCallExecutionResult } from "../../modeling/types.js";
import { createServerDriver } from "../drivers/factory.js";
import type { ServerDriver } from "../drivers/types.js";
import type { McpServer } from "./types.js";

export abstract class SdkBackedServer implements McpServer {
  readonly name: string;
  readonly profile: ResolvedServerSpec["profile"];

  protected driver: ServerDriver | undefined;
  protected tools: Tool[] | undefined;
  private connectPromise: Promise<ServerSnapshot> | undefined;

  constructor(readonly spec: ResolvedServerSpec) {
    this.name = spec.name;
    this.profile = spec.profile;
  }

  abstract snapshot(): ServerSnapshot;

  async connect(): Promise<ServerSnapshot> {
    if (this.driver) {
      return this.snapshot();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectFresh();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async getCatalog(): Promise<ServerCatalogResult> {
    await this.connect();
    return {
      server: this.snapshot(),
      tools: this.tools ?? [],
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallExecutionResult> {
    await this.connect();
    if (!this.driver) {
      throw new Error(`No active connection for MCP server: ${this.name}`);
    }

    const result = await this.driver.callTool(name, args);
    return {
      server: this.snapshot(),
      toolName: name,
      args,
      result,
    };
  }

  async close(): Promise<void> {
    const driver = this.driver;
    this.driver = undefined;
    this.tools = undefined;
    await driver?.close().catch(() => {});
  }

  getServerDescription(): string | undefined {
    return this.driver?.getServerDescription();
  }

  protected async openDriver(): Promise<void> {
    const nextDriver = createServerDriver(this.spec);
    try {
      await nextDriver.open();
      this.tools = await nextDriver.listTools();
      const previous = this.driver;
      this.driver = nextDriver;
      await previous?.close().catch(() => {});
    } catch (error) {
      await nextDriver.close().catch(() => {});
      throw error;
    }
  }

  protected abstract connectFresh(): Promise<ServerSnapshot>;
}
