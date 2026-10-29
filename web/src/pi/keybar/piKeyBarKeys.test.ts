import { describe, expect, it } from "vitest";

import { piKeyBarKeys, piKeyBarState } from "./piKeyBarKeys";

describe("piKeyBarState", () => {
  it("follows Pi State while the bridge is online", () => {
    expect(piKeyBarState("online", "idle")).toBe("idle");
    expect(piKeyBarState("online", "busy")).toBe("busy");
    expect(piKeyBarState("online", "dialog")).toBe("dialog");
  });

  it("falls back to the idle key set when the bridge is not online", () => {
    expect(piKeyBarState("offline", "busy")).toBe("idle");
    expect(piKeyBarState("connecting", "dialog")).toBe("idle");
    expect(piKeyBarState("unknown-pane", "busy")).toBe("idle");
  });

  it("falls back to idle before the first state record arrives", () => {
    expect(piKeyBarState("online", null)).toBe("idle");
  });
});

describe("piKeyBarKeys", () => {
  it("offers the idle shortcuts the Composer does not already own", () => {
    expect(piKeyBarKeys("idle").map((key) => [key.id, key.data])).toEqual([
      ["bang", "!"],
      ["thinking", "\x1b[Z"],
      ["tools", "\x0f"],
      ["history", "\x1b[A"],
    ]);
  });

  it("offers abort, steer and queue while Pi is busy", () => {
    expect(piKeyBarKeys("busy").map((key) => [key.id, key.data])).toEqual([
      ["abort", "\x1b"],
      ["steer", "\r"],
      ["queue", "\x1b\r"],
      ["tools", "\x0f"],
    ]);
  });

  it("offers dialog navigation while a dialog owns the terminal", () => {
    expect(piKeyBarKeys("dialog").map((key) => [key.id, key.data])).toEqual([
      ["up", "\x1b[A"],
      ["down", "\x1b[B"],
      ["confirm", "\r"],
      ["escape", "\x1b"],
      ["space", " "],
    ]);
  });

  it("names every symbol-only key in words a thumb can read", () => {
    for (const state of ["idle", "busy", "dialog"] as const) {
      for (const key of piKeyBarKeys(state)) {
        const symbolOnly = !/[A-Za-z]{2,}/.test(key.label);
        if (symbolOnly) {
          expect(key.hint, `${state}:${key.id}`).toMatch(/^[A-Za-z]{2,8}$/);
        }
      }
    }
  });

  it("keeps every visible label or hint inside the accessible name (label in name)", () => {
    for (const state of ["idle", "busy", "dialog"] as const) {
      for (const key of piKeyBarKeys(state)) {
        const visible = /[A-Za-z]{2,}/.test(key.label) ? key.label : key.hint;
        expect(visible, `${state}:${key.id}`).toBeTruthy();
        expect(key.ariaLabel.toLowerCase(), `${state}:${key.id}`).toContain(visible!.toLowerCase());
      }
    }
  });

  it("gives every key a label and an accessible name", () => {
    for (const state of ["idle", "busy", "dialog"] as const) {
      for (const key of piKeyBarKeys(state)) {
        expect(key.label).not.toBe("");
        expect(key.ariaLabel).not.toBe("");
        expect(key.data.length).toBeGreaterThan(0);
      }
    }
  });
});