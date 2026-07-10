import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFooterStatus,
  setFooterStatusSink,
  updateFooterStatus,
} from "../extensions/rendering/footer-status.js";

describe("footer status", () => {
  afterEach(() => {
    clearFooterStatus();
  });

  it("updates the fixed footer status with connected and total counts", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });

    updateFooterStatus(1, 4);

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", "1/4 MCP");
  });

  it("is a no-op when no sink is registered", () => {
    setFooterStatusSink(undefined);

    expect(() => updateFooterStatus(1, 4)).not.toThrow();
    expect(() => clearFooterStatus()).not.toThrow();
  });

  it("removes the footer status when cleared", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });

    clearFooterStatus();

    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("releases the sink after clearing", () => {
    const setStatus = vi.fn();
    setFooterStatusSink({ setStatus });
    clearFooterStatus();

    updateFooterStatus(2, 3);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("just-enough-mcp", undefined);
  });

  it("publishes updates only to the replacement sink", () => {
    const previousSetStatus = vi.fn();
    const currentSetStatus = vi.fn();
    setFooterStatusSink({ setStatus: previousSetStatus });
    setFooterStatusSink({ setStatus: currentSetStatus });

    updateFooterStatus(3, 5);

    expect(previousSetStatus).not.toHaveBeenCalled();
    expect(currentSetStatus).toHaveBeenCalledWith("just-enough-mcp", "3/5 MCP");
  });
});
