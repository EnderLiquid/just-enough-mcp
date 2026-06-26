import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServerSpec, RuntimeServerState, RuntimeServerStatus } from "../modeling/types.js";
import type { CompatibilityProfileRef } from "./profiles/types.js";
import type { ServerDriver } from "./drivers/types.js";

export interface RuntimeSlot {
  state: RuntimeServerState;
  profile: CompatibilityProfileRef;
  driver?: ServerDriver;
}

export function createRuntimeSlot(config: ResolvedServerSpec): RuntimeSlot {
  return {
    state: {
      config,
      status: "disconnected",
    },
    profile: {
      id: config.initialProfileId,
      source: "config-derived",
    },
  };
}

export function updateRuntimeSlotConfig(slot: RuntimeSlot, config: ResolvedServerSpec): void {
  slot.state.config = config;
  slot.profile = {
    id: config.initialProfileId,
    source: "config-derived",
  };
}

export function setRuntimeSlotStatus(slot: RuntimeSlot, status: RuntimeServerStatus, error?: string): RuntimeServerState {
  slot.state.status = status;
  slot.state.error = error;
  return slot.state;
}

export function setRuntimeSlotTools(slot: RuntimeSlot, tools: Tool[]): void {
  slot.state.tools = tools;
}

export function clearRuntimeSlotError(slot: RuntimeSlot): void {
  slot.state.error = undefined;
}
