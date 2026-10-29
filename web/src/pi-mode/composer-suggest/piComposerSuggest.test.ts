import { describe, expect, it } from "vitest";

import {
  PI_COMPOSER_SUGGESTION_LIMIT,
  applyPiComposerSuggestion,
  piComposerCatalogSuggestions,
  piComposerFileSuggestions,
  piComposerSuggestionInsertion,
  piComposerTrigger,
} from "./piComposerSuggest";

const CATALOG = {
  commands: [
    { name: "/compact", description: "Compact the session", source: "builtin" },
    { name: "/review", description: "Review the diff", source: "builtin" },
    { name: "/clear", description: "Clear the session", source: "builtin" },
  ],
  skills: [
    { name: "tdd", description: "Write tests first", source: "skill" },
    { name: "diagnosing-bugs", description: "Find the root cause", source: "skill" },
  ],
};

describe("piComposerTrigger", () => {
  it("opens on / only while it is the first token of the draft", () => {
    expect(piComposerTrigger("/", 1)).toEqual({ kind: "slash", start: 0, query: "" });
    expect(piComposerTrigger("/co", 3)).toEqual({ kind: "slash", start: 0, query: "co" });
    expect(piComposerTrigger("/co ", 4)).toBeNull();
    expect(piComposerTrigger("hello /co", 9)).toBeNull();
    expect(piComposerTrigger("", 0)).toBeNull();
  });

  it("opens on @ inside the current token", () => {
    expect(piComposerTrigger("@", 1)).toEqual({ kind: "file", start: 0, query: "" });
    expect(piComposerTrigger("read @sr", 8)).toEqual({ kind: "file", start: 5, query: "sr" });
    expect(piComposerTrigger("read @sr more", 12)).toBeNull();
    expect(piComposerTrigger("mail@example.com", 16)).toBeNull();
  });
});

describe("piComposerSuggestionInsertion", () => {
  it("normalises command, skill and file insertions", () => {
    expect(piComposerSuggestionInsertion("command", "compact")).toBe("/compact");
    expect(piComposerSuggestionInsertion("command", "/compact")).toBe("/compact");
    expect(piComposerSuggestionInsertion("skill", "tdd")).toBe("/skill:tdd");
    expect(piComposerSuggestionInsertion("file", "docs/a b.md")).toBe('@"docs/a b.md"');
    expect(piComposerSuggestionInsertion("file", "src/a.ts")).toBe("@src/a.ts");
  });

  it("replaces the trigger token at the cursor and keeps the rest of the draft", () => {
    const trigger = piComposerTrigger("hello @sr world", 9);
    if (!trigger) {
      throw new Error("expected a file trigger");
    }
    expect(
      applyPiComposerSuggestion("hello @sr world", trigger, 9, "@src/a.ts"),
    ).toEqual({ value: "hello @src/a.ts world", cursor: 16 });

    const slash = piComposerTrigger("/co", 3);
    if (!slash) {
      throw new Error("expected a slash trigger");
    }
    expect(applyPiComposerSuggestion("/co now", slash, 3, "/compact")).toEqual({
      value: "/compact now",
      cursor: 9,
    });
  });
});

describe("piComposerCatalogSuggestions", () => {
  it("filters commands and skills by name and keeps their descriptions", () => {
    expect(piComposerCatalogSuggestions(CATALOG, "").map((item) => item.kind)).toEqual([
      "command",
      "command",
      "command",
      "skill",
      "skill",
    ]);
    const compact = piComposerCatalogSuggestions(CATALOG, "co");
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({
      kind: "command",
      label: "/compact",
      description: "Compact the session",
      insert: "/compact",
    });
    const skill = piComposerCatalogSuggestions(CATALOG, "diag");
    expect(skill).toHaveLength(1);
    expect(skill[0]).toMatchObject({ kind: "skill", label: "/skill:diagnosing-bugs" });
  });

  it("caps the combined command and skill list", () => {
    const commands = Array.from({ length: 30 }, (_, index) => ({
      name: `/command-${index}`,
      description: `Command ${index}`,
      source: "builtin",
    }));
    const items = piComposerCatalogSuggestions({ commands, skills: [] }, "");
    expect(items).toHaveLength(PI_COMPOSER_SUGGESTION_LIMIT);
  });
});

describe("completion parity", () => {
  it("supports unfinished quoted paths and preserves suffixes with one separator", () => {
    expect(piComposerTrigger('read @"docs/a b', 15)).toEqual({ kind: "file", start: 5, query: "docs/a b" });
    const trigger = piComposerTrigger("read @sr trailing", 8)!;
    expect(applyPiComposerSuggestion("read @sr trailing", trigger, 8, "@src/a.ts")).toEqual({value: "read @src/a.ts trailing", cursor: 15});
    expect(applyPiComposerSuggestion("@sr", {kind: "file", start: 0, query: "sr"}, 3, "@src/a.ts")).toEqual({value:"@src/a.ts ",cursor:10});
  });
  it("searches descriptions, ranks exact/prefix first, and gates skills", () => {
    expect(piComposerCatalogSuggestions(CATALOG, "root", true)[0]?.insert).toBe("/skill:diagnosing-bugs");
    expect(piComposerCatalogSuggestions(CATALOG, "tdd", false)).toEqual([]);
    // Catalog order is reversed on purpose: only ranking can produce this order.
    const ranked = piComposerCatalogSuggestions({
      commands: [],
      skills: [
        { name: "readme-writer", description: "docs", source: "skill" },
        { name: "other", description: "mentions readme", source: "skill" },
        { name: "my-readme", description: "docs", source: "skill" },
        { name: "readme", description: "docs", source: "skill" },
      ],
    }, "readme");
    expect(ranked.map(item => item.insert)).toEqual([
      "/skill:readme",
      "/skill:readme-writer",
      "/skill:my-readme",
      "/skill:other",
    ]);
    expect(piComposerFileSuggestions([{path:"x/my-readme.md"},{path:"docs/readme.md"},{path:"readme.md"}], "readme.md").map(x => x.label)).toEqual(["readme.md", "docs/readme.md", "x/my-readme.md"]);
  });
});

describe("piComposerFileSuggestions", () => {
  it("filters and caps file paths", () => {
    const files = Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.ts` }));
    const items = piComposerFileSuggestions(files, "src");
    expect(items).toHaveLength(PI_COMPOSER_SUGGESTION_LIMIT);
    expect(items[0]).toMatchObject({
      kind: "file",
      label: "src/file-0.ts",
      insert: "@src/file-0.ts",
    });
    expect(piComposerFileSuggestions(files, "nomatch")).toEqual([]);
  });
});
