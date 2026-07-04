import { describe, expect, it } from "vitest";
import { pluralize } from "../extensions/formatting/english.js";

describe("pluralize", () => {
  it("uses the singular form only for one", () => {
    expect(pluralize(1, "tool")).toBe("tool");
    expect(pluralize(0, "tool")).toBe("tools");
    expect(pluralize(2, "tool")).toBe("tools");
  });

  it("supports phrase nouns", () => {
    expect(pluralize(1, "payload item")).toBe("payload item");
    expect(pluralize(2, "payload item")).toBe("payload items");
  });

  it("supports an explicit plural form", () => {
    expect(pluralize(1, "entry", "entries")).toBe("entry");
    expect(pluralize(2, "entry", "entries")).toBe("entries");
  });
});
