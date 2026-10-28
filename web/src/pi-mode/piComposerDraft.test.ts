/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import {
  piComposerDraftKey,
  readPiComposerDraft,
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
    expect(() => writePiComposerDraft(BRIDGE, "pane-a", "value", throwing)).not.toThrow();
    expect(() => retainPiComposerDrafts(BRIDGE, [], throwing)).not.toThrow();
  });
});
