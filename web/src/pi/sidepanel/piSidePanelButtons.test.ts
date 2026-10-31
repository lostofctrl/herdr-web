import { describe, expect, it, vi, afterEach } from "vitest";
import { buildHttpUrl } from "../../bridge";
import { defaultPiSidePanelButtons, fetchPiSidePanelButtons, parsePiSidePanelButtons, putPiSidePanelButtons } from "./piSidePanelButtons";

const custom = { id: "custom-one", title: "Hello", icon: { type: "lucide", name: "star" }, action: { type: "prompt", text: "hello\nworld", delivery: "insert" } };
const state = { ...defaultPiSidePanelButtons(), buttons: [custom], pinned: ["abort", "custom-one"] };

afterEach(() => vi.restoreAllMocks());

describe("side panel button model", () => {
  it("accepts the default and valid custom entries", () => {
    expect(parsePiSidePanelButtons(state)).toEqual(state);
    expect(parsePiSidePanelButtons(defaultPiSidePanelButtons()).pinned).toEqual(["abort", "compact", "new-session", "resume", "chat-log"]);
  });

  it("accepts boundary lengths and both icon and action variants", () => {
    const boundary = { ...state, buttons: [
      { ...custom, title: "x".repeat(80), icon: { type: "glyph", text: "⭐".repeat(16) }, action: { type: "prompt", text: "é".repeat(4096), delivery: "send" } },
      { ...custom, id: "custom-two", action: { type: "builtin", id: "chat-log" } },
    ] };
    expect(parsePiSidePanelButtons(boundary)).toEqual(boundary);
  });

  it("rejects invalid versions, revision, ids, references, limits, controls and variants", () => {
    const invalid = [
      { ...state, schema_version: 2 }, { ...state, revision: -1 },
      { ...state, buttons: [{ ...custom, id: "one" }] },
      { ...state, buttons: [{ ...custom, id: "custom-" }] },
      { ...state, buttons: [{ ...custom, id: "custom-space here" }] },
      { ...state, buttons: [{ ...custom, id: `custom-${"x".repeat(122)}` }] },
      { ...state, buttons: [{ ...custom, title: "   " }] },
      { ...state, buttons: [{ ...custom, icon: { type: "glyph", text: " " } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, text: "\n " } }] },
      { ...state, buttons: [{ ...custom, extra: true }] },
      { ...state, buttons: [custom, custom] }, { ...state, pinned: ["missing"] },
      { ...state, pinned: ["abort", "abort"] },
      { ...state, buttons: Array.from({ length: 65 }, (_, i) => ({ ...custom, id: `custom-${i}` })) },
      { ...state, buttons: [{ ...custom, title: "a".repeat(81) }] },
      { ...state, buttons: [{ ...custom, title: "bad\nname" }] },
      { ...state, buttons: [{ ...custom, title: "\ufeff" }] },
      { ...state, buttons: [{ ...custom, icon: { type: "glyph", text: "\ufeff" } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, text: "\ufeff" } }] },
      { ...state, buttons: [{ ...custom, title: "bad\u061cname" }] },
      { ...state, buttons: [{ ...custom, icon: { type: "glyph", text: "\u200e!" } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, text: "bad\u202etext" } }] },
      { ...state, buttons: [{ ...custom, icon: { type: "glyph", text: "x".repeat(17) } }] },
      { ...state, buttons: [{ ...custom, icon: { type: "lucide", name: "unknown" } }] },
      { ...state, buttons: [{ ...custom, action: { type: "builtin", id: "missing" } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, text: "é".repeat(4097) } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, text: "bad\ttext" } }] },
      { ...state, buttons: [{ ...custom, action: { ...custom.action, delivery: "other" } }] },
    ];
    for (const value of invalid) expect(() => parsePiSidePanelButtons(value)).toThrow();
  });

  it("uses the selected bridge URL for GET and whole-state PUT", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(state), { status: 200 }));
    const httpUrl = (path: string) => buildHttpUrl("https://bridge.example/proxy/one", path);
    await expect(fetchPiSidePanelButtons(httpUrl)).resolves.toEqual(state);
    await expect(putPiSidePanelButtons(httpUrl, parsePiSidePanelButtons(state))).resolves.toEqual(state);
    expect(fetchMock.mock.calls[0][0]).toBe("https://bridge.example/proxy/one/api/pi-sidepanel-buttons");
    expect(fetchMock.mock.calls[1][0]).toBe("https://bridge.example/proxy/one/api/pi-sidepanel-buttons");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT", body: JSON.stringify(state) });
  });
});
