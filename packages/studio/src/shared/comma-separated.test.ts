import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCommaSeparated, MixedCommaError, parseCommaSeparated, rememberCommaSeparated } from "./comma-separated";

describe("comma-separated form fields", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { name: "English commas", input: " first , second, third ", expected: ["first", "second", "third"] },
    { name: "Chinese commas", input: " 亲情， 友情 ，成长 ", expected: ["亲情", "友情", "成长"] },
    { name: "empty input", input: "", expected: [] },
    { name: "only Chinese separators", input: " ，\n， ", expected: [] },
    { name: "only English separators", input: " ,\n, ", expected: [] },
    { name: "text within an item", input: " found family ，慢节奏 romance ", expected: ["found family", "慢节奏 romance"] },
  ])("parses $name", ({ input, expected }) => {
    expect(parseCommaSeparated(input)).toEqual(expected);
  });

  it.each(["first,第二项，third", "， , ，", ",first，"]) ("rejects mixed commas: %s", (input) => {
    expect(() => parseCommaSeparated(input)).toThrow(MixedCommaError);
  });

  it("defaults to Chinese and restores that default when browser preferences are cleared", () => {
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a，b");
    rememberCommaSeparated("a,b", "/project", "genre", "tag", "chapterTypes");
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a, b");
    window.localStorage.clear();
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a，b");
  });

  it("remembers each field independently and allows switching comma types", () => {
    rememberCommaSeparated("a,b", "/project", "audience-style", "tag", "relationshipAndElements");
    rememberCommaSeparated("a，b", "/project", "audience-style", "tag", "avoidElements");
    expect(formatCommaSeparated(["a", "b"], "/project", "audience-style", "tag", "relationshipAndElements")).toBe("a, b");
    expect(formatCommaSeparated(["a", "b"], "/project", "audience-style", "tag", "avoidElements")).toBe("a，b");
    rememberCommaSeparated("a，b", "/project", "audience-style", "tag", "relationshipAndElements");
    expect(formatCommaSeparated(["a", "b"], "/project", "audience-style", "tag", "relationshipAndElements")).toBe("a，b");
  });

  it("isolates projects, entity kinds, ids and fields", () => {
    rememberCommaSeparated("a,b", "/one", "genre", "same-id", "field");
    expect(formatCommaSeparated(["a", "b"], "/two", "genre", "same-id", "field")).toBe("a，b");
    expect(formatCommaSeparated(["a", "b"], "/one", "audience-style", "same-id", "field")).toBe("a，b");
    expect(formatCommaSeparated(["a", "b"], "/one", "genre", "other-id", "field")).toBe("a，b");
    expect(formatCommaSeparated(["a", "b"], "/one", "genre", "same-id", "other-field")).toBe("a，b");
  });

  it("retains an earlier preference for single items and empty fields, and rejects mixed preferences", () => {
    rememberCommaSeparated("a,b", "/project", "genre", "tag", "chapterTypes");
    for (const value of ["", "single"]) rememberCommaSeparated(value, "/project", "genre", "tag", "chapterTypes");
    expect(() => rememberCommaSeparated("a,b，c", "/project", "genre", "tag", "chapterTypes")).toThrow(MixedCommaError);
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a, b");
  });

  it("defaults to Chinese when local storage is invalid or unavailable without failing a business save", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "invalid", setItem: () => { throw new Error("Denied"); } } });
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a，b");
    expect(() => rememberCommaSeparated("a,b", "/project", "genre", "tag", "chapterTypes")).not.toThrow();
    vi.stubGlobal("window", { get localStorage() { throw new Error("Denied"); } });
    expect(formatCommaSeparated(["a", "b"], "/project", "genre", "tag", "chapterTypes")).toBe("a，b");
  });
});
