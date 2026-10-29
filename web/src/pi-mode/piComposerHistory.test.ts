/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { clearPiComposerHistory, getPiComposerHistory, recordPiComposerHistory, retainPiComposerHistory } from "./piComposerHistory";

afterEach(() => { retainPiComposerHistory("test", []); retainPiComposerHistory("other", []); });
describe("memory-only pane prompt history", () => {
  it("stores original text newest first, suppresses adjacent duplicates and isolates bridge/pane", () => {
    recordPiComposerHistory("test", "a", " first ");
    recordPiComposerHistory("test", "a", "second");
    recordPiComposerHistory("test", "a", "second");
    expect(getPiComposerHistory("test", "a")).toEqual(["second", " first "]);
    expect(getPiComposerHistory("other", "a")).toEqual([]);
    expect(getPiComposerHistory("test", "b")).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
  it("bounds entries to 50 and 16 KiB UTF-8, skipping oversized/blank text", () => {
    for (let i=0;i<55;i++) recordPiComposerHistory("test", "a", String(i));
    recordPiComposerHistory("test", "a", "😀".repeat(4097));
    recordPiComposerHistory("test", "a", "   ");
    expect(getPiComposerHistory("test", "a")).toHaveLength(50);
    expect(getPiComposerHistory("test", "a")[0]).toBe("54");
  });
  it("keeps retained panes and prunes only closed panes of that bridge", () => {
    for (const b of ["test","other"]) for (const p of ["a","b"]) recordPiComposerHistory(b,p,"hello");
    retainPiComposerHistory("test", ["a"]);
    expect(getPiComposerHistory("test","a")).toEqual(["hello"]);
    expect(getPiComposerHistory("test","b")).toEqual([]);
    // Another bridge is untouched by this prune.
    expect(getPiComposerHistory("other","b")).toEqual(["hello"]);
    // Pruning every pane of the bridge drops that bridge's history only.
    retainPiComposerHistory("test", []);
    expect(getPiComposerHistory("test","a")).toEqual([]);
    expect(getPiComposerHistory("other","a")).toEqual(["hello"]);
  });
  it("clears one pane without touching its siblings", () => {
    recordPiComposerHistory("test","a","first");
    recordPiComposerHistory("test","b","second");
    clearPiComposerHistory("test","a");
    expect(getPiComposerHistory("test","a")).toEqual([]);
    expect(getPiComposerHistory("test","b")).toEqual(["second"]);
  });
});
