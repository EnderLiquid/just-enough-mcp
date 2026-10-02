export type McpTuiRenderMode = "hidden" | "minimal" | "expanded";

export interface TuiResultRenderSettings {
  renderMode: McpTuiRenderMode;
  expandedModeCollapsedLines: number;
}

export const DEFAULT_TUI_RESULT_RENDER_SETTINGS: TuiResultRenderSettings = {
  renderMode: "expanded",
  expandedModeCollapsedLines: 4,
};
