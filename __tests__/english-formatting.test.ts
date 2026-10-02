import { describe, expect, it } from "vitest";
import { pluralize } from "../packages/core/src/formatting/english.js";

describe("pluralize", () => {
  it("只在数量为 1 时使用单数形式", () => {
    expect(pluralize(1, "tool")).toBe("tool");
    expect(pluralize(0, "tool")).toBe("tools");
    expect(pluralize(2, "tool")).toBe("tools");
  });

  it("支持短语名词", () => {
    expect(pluralize(1, "payload item")).toBe("payload item");
    expect(pluralize(2, "payload item")).toBe("payload items");
  });

  it("支持显式指定复数形式", () => {
    expect(pluralize(1, "entry", "entries")).toBe("entry");
    expect(pluralize(2, "entry", "entries")).toBe("entries");
  });
});
