/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readPiComposerDraft, writePiComposerDraft, writePiComposerInputUnresolved } from "../../pi-mode/piComposerDraft";
import { insertPiComposerText, PI_COMPOSER_INSERT_EVENT } from "./piComposerInsert";

beforeEach(() => localStorage.clear());

describe("insertPiComposerText", () => {
  it("reports insertion when the unmounted draft is updated", () => {
    writePiComposerDraft("host", "pane", "draft");
    expect(insertPiComposerText("host", "pane", "/review")).toBe("inserted");
    expect(readPiComposerDraft("host", "pane")).toBe("draft\n/review");
  });

  it("blocks fallback insertion when an unmounted pane has unresolved terminal input", () => {
    writePiComposerDraft("host", "unmounted-recovery", "draft");
    writePiComposerInputUnresolved("host", "unmounted-recovery", true);
    try {
      expect(insertPiComposerText("host", "unmounted-recovery", "/review")).toBe("blocked");
      expect(readPiComposerDraft("host", "unmounted-recovery")).toBe("draft");
    } finally { writePiComposerInputUnresolved("host", "unmounted-recovery", false); }
  });

  it("reports a mounted listener's rejection without changing the stored draft", () => {
    writePiComposerDraft("host", "pane", "draft");
    const listener = (event: Event) => event.preventDefault();
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    try {
      expect(insertPiComposerText("host", "pane", "/review")).toBe("blocked");
      expect(readPiComposerDraft("host", "pane")).toBe("draft");
    } finally {
      window.removeEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    }
  });

  it("reports unavailable when the stored draft cannot be read or written", () => {
    writePiComposerDraft("host", "pane", "draft");
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(insertPiComposerText("host", "pane", "/review")).toBe("unavailable");
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(insertPiComposerText("host", "pane", "/review")).toBe("unavailable");
    write.mockRestore();
    expect(readPiComposerDraft("host", "pane")).toBe("draft");
  });

  it("reports a mounted listener's accepted insertion without overwriting storage", () => {
    writePiComposerDraft("host", "pane", "stored");
    const listener = (event: Event) => {
      (event as CustomEvent<{ result?: string }>).detail.result = "inserted";
      event.preventDefault();
    };
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    try {
      expect(insertPiComposerText("host", "pane", "/review")).toBe("inserted");
      expect(readPiComposerDraft("host", "pane")).toBe("stored");
    } finally {
      window.removeEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    }
  });

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
      expect(events).toEqual([
        {
          key: "herdr.pi-mode.composer-draft:host:pane",
          value: "Existing draft\n/skill:tdd",
          text: "/skill:tdd",
        },
      ]);
    } finally {
      window.removeEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    }
  });

  it("leaves storage to a mounted Composer that cancels the event", () => {
    writePiComposerDraft("host", "pane", "stored draft");
    const listener = (event: Event) => event.preventDefault();
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, listener);
    try {
      insertPiComposerText("host", "pane", "/review");
      // The Composer owns the live draft, so the stale stored one is untouched.
      expect(readPiComposerDraft("host", "pane")).toBe("stored draft");
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
