import type { CorePluginConfigLoadResult } from "@enderliquid/just-enough-mcp";
import type { TuiResultRenderSettings } from "../rendering/types.js";

export interface PluginConfigLoadResult extends CorePluginConfigLoadResult {
  configPaths: string[];
  artifactDir: string;
  tui: TuiResultRenderSettings;
}
