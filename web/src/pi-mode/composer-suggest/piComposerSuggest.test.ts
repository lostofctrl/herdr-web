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
    expect(piComposerSuggestionInsertion("skill", "tdd")).toBe("tdd");
    expect(piComposerSuggestionInsertion("file", "src/a.ts")).toBe("@src/a.ts");
  });

  it("replaces the trigger token at the cursor and keeps the rest of the draft", () => {
    const trigger = piComposerTrigger("hello @sr world", 9);
    if (!trigger) {
      throw new Error("expected a file trigger");
    }
    expect(
      applyPiComposerSuggestion("hello @sr world", trigger, 9, "@src/a.ts"),
    ).toEqual({ value: "hello @src/a.ts world", cursor: 15 });

    const slash = piComposerTrigger("/co", 3);
    if (!slash) {
      throw new Error("expected a slash trigger");
    }
    expect(applyPiComposerSuggestion("/co now", slash, 3, "/compact")).toEqual({
      value: "/compact now",
      cursor: 8,
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
    expect(skill[0]).toMatchObject({ kind: "skill", label: "diagnosing-bugs" });
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
