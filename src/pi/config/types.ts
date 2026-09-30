import type { CorePluginConfigLoadResult } from "../../core/config/plugin-config.js";
import type { TuiResultRenderSettings } from "../rendering/types.js";

export interface PluginConfigLoadResult extends CorePluginConfigLoadResult {
  artifactDir: string;
  tui: TuiResultRenderSettings;
}
