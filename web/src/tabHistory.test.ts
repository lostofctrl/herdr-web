import { describe, expect, it } from "vitest";
import { appendTabVisit, findTabVisit, readTabHistory, writeTabHistory } from "./tabHistory";

const a = { bridgeId: "one", tabId: "a" };
const b = { bridgeId: "one", tabId: "b" };
const c = { bridgeId: "two", tabId: "c" };

describe("tab history", () => {
  it("records distinct visits across bridges and truncates forward history", () => {
    let history = appendTabVisit({ entries: [], index: -1 }, a);
    history = appendTabVisit(history, a);
    history = appendTabVisit(history, b);
    history = appendTabVisit(history, c);
    expect(history).toEqual({ entries: [a, b, c], index: 2 });
    expect(appendTabVisit({ ...history, index: 0 }, c)).toEqual({ entries: [a, c], index: 1 });
  });

  it("finds the next available tab without destroying unavailable entries", () => {
    const history = { entries: [a, b, c], index: 2 };
    expect(findTabVisit(history, -1, (entry) => entry.tabId !== "b")).toBe(0);
    expect(findTabVisit(history, 1, () => true)).toBe(-1);
    expect(history.entries).toEqual([a, b, c]);
  });

  it("persists validated history and tolerates unavailable or malformed storage", () => {
    let value = "";
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const history = { entries: [a, b], index: 0 };
    writeTabHistory(history, storage);
    expect(readTabHistory(storage)).toEqual(history);
    value = '{"entries":[{"bridgeId":7}],"index":0}';
    expect(readTabHistory(storage)).toEqual({ entries: [], index: -1 });
    expect(readTabHistory({ getItem: () => { throw new Error("denied"); } })).toEqual({ entries: [], index: -1 });
    expect(() => writeTabHistory(history, { setItem: () => { throw new Error("denied"); } })).not.toThrow();
  });

  it("bounds history while keeping the latest visit", () => {
    let history = { entries: [] as typeof a[], index: -1 };
    for (let i = 0; i < 150; i++) history = appendTabVisit(history, { bridgeId: "one", tabId: String(i) });
    expect(history.entries).toHaveLength(100);
    expect(history.index).toBe(99);
    expect(history.entries[99].tabId).toBe("149");
  });
});
