/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readRecentPiTriggers, rememberPiTrigger } from "./piSidePanelRecents";

describe("side panel recents", () => {
  beforeEach(() => localStorage.clear());

  it("deduplicates selections and persists most recent first", () => {
    const first = rememberPiTrigger("/alpha", []);
    const second = rememberPiTrigger("/beta", first);
    expect(rememberPiTrigger("/alpha", second)).toEqual(["/alpha", "/beta"]);
    expect(readRecentPiTriggers()).toEqual(["/alpha", "/beta"]);
  });

  it("ignores malformed storage and continues in memory if storage is unavailable", () => {
    localStorage.setItem("herdr.pi.side-panel.recents", "not json");
    expect(readRecentPiTriggers()).toEqual([]);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      const first = rememberPiTrigger("/alpha", []);
      expect(rememberPiTrigger("/beta", first)).toEqual(["/beta", "/alpha"]);
    } finally {
      setItem.mockRestore();
    }
  });
});
