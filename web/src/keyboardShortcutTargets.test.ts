/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { isShortcutTextEntryTarget } from "./keyboardShortcutTargets";

describe("isShortcutTextEntryTarget", () => {
  it("protects the focused terminal input from app shortcuts", () => {
    const input = document.createElement("textarea");
    input.classList.add("ghostty-hidden-input");
    expect(isShortcutTextEntryTarget(input)).toBe(true);
  });

  it("still protects normal form controls and ignores non-input elements", () => {
    expect(isShortcutTextEntryTarget(document.createElement("input"))).toBe(true);
    expect(isShortcutTextEntryTarget(document.createElement("div"))).toBe(false);
  });
});
