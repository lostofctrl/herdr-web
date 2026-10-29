/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPiComposerDraftIf,
  piComposerDraftKey,
  readPiComposerDraft,
  readPiComposerInputUnresolved,
  writePiComposerInputUnresolved,
  retainPiComposerDrafts,
  writePiComposerDraft,
} from "./piComposerDraft";

const BRIDGE = "bridge:1";
const OTHER_BRIDGE = "bridge-2";

beforeEach(() => {
  window.localStorage.clear();
});

describe("Pi Composer drafts", () => {
  it("keeps one draft per bridge and pane, and removes it when cleared", () => {
    writePiComposerDraft(BRIDGE, "pane-a", "draft a");
    writePiComposerDraft(BRIDGE, "pane-b", "draft b");
    writePiComposerDraft(OTHER_BRIDGE, "pane-a", "other bridge");

    expect(readPiComposerDraft(BRIDGE, "pane-a")).toBe("draft a");
    expect(readPiComposerDraft(BRIDGE, "pane-b")).toBe("draft b");
    expect(readPiComposerDraft(OTHER_BRIDGE, "pane-a")).toBe("other bridge");

    writePiComposerDraft(BRIDGE, "pane-a", "");
    expect(readPiComposerDraft(BRIDGE, "pane-a")).toBe("");
    expect(
      Object.keys(window.localStorage).includes(piComposerDraftKey(BRIDGE, "pane-a")),
    ).toBe(false);
  });

  it("drops drafts for panes that left the snapshot and keeps live panes", () => {
    writePiComposerDraft(BRIDGE, "pane-a", "keep me");
    writePiComposerDraft(BRIDGE, "pane-closed", "closed pane");
    writePiComposerDraft(OTHER_BRIDGE, "pane-b", "other bridge");

    retainPiComposerDrafts(BRIDGE, ["pane-a"]);

    expect(readPiComposerDraft(BRIDGE, "pane-a")).toBe("keep me");
    expect(readPiComposerDraft(BRIDGE, "pane-closed")).toBe("");
    // Another bridge's drafts are not touched by this bridge's snapshot.
    expect(readPiComposerDraft(OTHER_BRIDGE, "pane-b")).toBe("other bridge");
  });

  it("retains unresolved input with live pane drafts without treating draft clearing as terminal-empty confirmation", () => {
    writePiComposerDraft(BRIDGE, "pane-a", "keep draft");
    writePiComposerInputUnresolved(BRIDGE, "pane-a", true);
    writePiComposerInputUnresolved(BRIDGE, "pane-closed", true);
    writePiComposerInputUnresolved(OTHER_BRIDGE, "pane-a", true);
    retainPiComposerDrafts(BRIDGE, ["pane-a"]);
    clearPiComposerDraftIf(BRIDGE, "pane-a", "keep draft");
    expect(readPiComposerInputUnresolved(BRIDGE, "pane-a")).toBe(true);
    expect(readPiComposerInputUnresolved(BRIDGE, "pane-closed")).toBe(false);
    expect(readPiComposerInputUnresolved(OTHER_BRIDGE, "pane-a")).toBe(true);
    writePiComposerInputUnresolved(BRIDGE, "pane-a", false);
    expect(readPiComposerInputUnresolved(BRIDGE, "pane-a")).toBe(false);
  });

  it("keeps an in-memory unresolved marker when browser storage is unavailable", () => {
    writePiComposerInputUnresolved(BRIDGE, "no-storage", true, null);
    expect(readPiComposerInputUnresolved(BRIDGE, "no-storage", null)).toBe(true);
    expect(readPiComposerInputUnresolved(OTHER_BRIDGE, "no-storage", null)).toBe(false);
    retainPiComposerDrafts(BRIDGE, ["no-storage"], null);
    expect(readPiComposerInputUnresolved(BRIDGE, "no-storage", null)).toBe(true);
    writePiComposerInputUnresolved(BRIDGE, "no-storage", false, null);
    expect(readPiComposerInputUnresolved(BRIDGE, "no-storage", null)).toBe(false);
  });

  it("drops a delivered draft without discarding newer text", () => {
    writePiComposerDraft(BRIDGE, "pane-a", "delivered prompt");
    clearPiComposerDraftIf(BRIDGE, "pane-a", "delivered prompt");
    expect(readPiComposerDraft(BRIDGE, "pane-a")).toBe("");

    // A recall or a retype after the send started is not the delivered text.
    writePiComposerDraft(BRIDGE, "pane-a", "recalled older prompt");
    clearPiComposerDraftIf(BRIDGE, "pane-a", "delivered prompt");
    expect(readPiComposerDraft(BRIDGE, "pane-a")).toBe("recalled older prompt");

    expect(() => clearPiComposerDraftIf(BRIDGE, "pane-a", "x", null)).not.toThrow();
  });

  it("survives storage that throws", () => {
    const throwing = {
      get length(): number {
        throw new Error("denied");
      },
      key() {
        throw new Error("denied");
      },
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;

    expect(readPiComposerDraft(BRIDGE, "pane-a", throwing)).toBe("");
    expect(readPiComposerInputUnresolved(BRIDGE, "pane-a", throwing)).toBe(true);
    writePiComposerInputUnresolved(BRIDGE, "unwritable", true, throwing);
    expect(readPiComposerInputUnresolved(BRIDGE, "unwritable", null)).toBe(true);
    writePiComposerInputUnresolved(BRIDGE, "unwritable", false, null);
    expect(() => writePiComposerDraft(BRIDGE, "pane-a", "value", throwing)).not.toThrow();
    expect(() => retainPiComposerDrafts(BRIDGE, [], throwing)).not.toThrow();
  });
});
