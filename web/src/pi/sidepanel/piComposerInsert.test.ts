/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import { readPiComposerDraft, writePiComposerDraft } from "../../pi-mode/piComposerDraft";
import { insertPiComposerText, PI_COMPOSER_INSERT_EVENT } from "./piComposerInsert";

beforeEach(() => localStorage.clear());

describe("insertPiComposerText", () => {
  it("appends without joining tokens, persists and notifies only the addressed draft", () => {
    writePiComposerDraft("host", "pane", "Existing draft");
    writePiComposerDraft("other", "pane", "Other host");
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    try {
      insertPiComposerText("host", "pane", "/skill:tdd");
      expect(readPiComposerDraft("host", "pane")).toBe("Existing draft\n/skill:tdd");
      expect(readPiComposerDraft("other", "pane")).toBe("Other host");
      expect(events).toEqual([{ key: "herdr.pi-mode.composer-draft:host:pane", value: "Existing draft\n/skill:tdd" }]);
    } finally {
      window.removeEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    }
  });

  it("inserts into an empty draft and preserves an existing separator", () => {
    insertPiComposerText("host", "pane", "/review");
    expect(readPiComposerDraft("host", "pane")).toBe("/review");
    writePiComposerDraft("host", "pane", "Draft\n");
    insertPiComposerText("host", "pane", "/new");
    expect(readPiComposerDraft("host", "pane")).toBe("Draft\n/new");
    insertPiComposerText("host", "pane", "");
    expect(readPiComposerDraft("host", "pane")).toBe("Draft\n/new");
  });
});
