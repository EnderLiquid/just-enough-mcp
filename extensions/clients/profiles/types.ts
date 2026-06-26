import type { CompatibilityProfileId } from "../../modeling/types.js";

export type CompatibilityProfileSource = "config-derived" | "observed" | "manual-override";

export interface CompatibilityProfileRef {
  id: CompatibilityProfileId;
  source: CompatibilityProfileSource;
}
