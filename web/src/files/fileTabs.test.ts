import { describe, expect, it } from "vitest";

import {
  fileTabKey,
  loadFileTabs,
  partitionFileTabs,
  saveFileTabs,
  deserializeFileTabs,
  serializeFileTabs,
  type FileTab,
} from "./fileTabs";

const binding = {
  bridgeId: "bridge-a",
  connectionKey: "https://example.test/bridge",
  bridgeIdentity: "host-a",
  rootIdentity: "root-a",
  bindingIdentity: "live-binding-a",
};
const tab: FileTab = { binding, path: "a.txt", draft: "unsaved", dirty: true, baseContent: "original", baseRevision: "rev-1" };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("browser file tabs", () => {
  it("uses unambiguous keys for every binding component and path", () => {
    const a = { ...tab, binding: { ...binding, bridgeId: "a:b", connectionKey: "c" } };
    const b = { ...tab, binding: { ...binding, bridgeId: "a", connectionKey: "b:c" } };
    expect(fileTabKey(a)).not.toBe(fileTabKey(b));
    for (const changed of [
      { ...binding, bridgeId: "other" },
      { ...binding, connectionKey: "https://example.test/other" },
      { ...binding, bridgeIdentity: "host-b" },
      { ...binding, rootIdentity: "/root-b" },
    ]) expect(fileTabKey(tab)).not.toBe(fileTabKey({ ...tab, binding: changed }));
    expect(fileTabKey(tab)).not.toBe(fileTabKey({ ...tab, path: "b.txt" }));
  });

  it("isolates mismatched bridge id, URL, server host and root without losing dirty drafts", () => {
    const changed = [
      { ...binding, bridgeId: "bridge-b" },
      { ...binding, connectionKey: "https://example.test/new" },
      { ...binding, bridgeIdentity: "host-b" },
      { ...binding, rootIdentity: "/root-b" },
    ];
    for (const current of changed) {
      expect(partitionFileTabs([tab], current)).toEqual({ matching: [], recovery: [tab] });
    }
    expect(partitionFileTabs([tab], binding)).toEqual({ matching: [tab], recovery: [] });
  });

  it("quarantines drafts after restart until the current root is explicitly confirmed", () => {
    const restarted = { ...binding, bindingIdentity: "live-binding-b" };
    expect(partitionFileTabs([tab], restarted)).toEqual({ matching: [], recovery: [tab] });
    const confirmed = partitionFileTabs([tab], restarted, true);
    expect(confirmed).toEqual({ matching: [{ ...tab, binding: restarted }], recovery: [] });
    expect(partitionFileTabs(confirmed.matching, restarted)).toEqual(confirmed);
    expect(partitionFileTabs([tab], { ...restarted, rootIdentity: "root-b" }, true))
      .toEqual({ matching: [], recovery: [tab] });
    expect(partitionFileTabs([tab], { ...restarted, bridgeIdentity: "host-b" }, true))
      .toEqual({ matching: [], recovery: [tab] });
  });

  it("round-trips multiple tabs and restores them after a reload", () => {
    const tabs = [tab, { binding, path: "b.txt", draft: "", dirty: false }, {
      ...tab, binding: { ...binding, bridgeIdentity: "host-b" }, draft: "other host",
    }];
    expect(deserializeFileTabs(serializeFileTabs(tabs))).toEqual({ ok: true, tabs });
    const storage = memoryStorage();
    expect(saveFileTabs(storage, tabs)).toEqual({ ok: true, tabs });
    const loaded = loadFileTabs(storage);
    expect(loaded).toEqual({ ok: true, tabs });
    if (loaded.ok) {
      const partition = partitionFileTabs(loaded.tabs, binding);
      expect(partition).toEqual({ matching: tabs.slice(0, 2), recovery: [tabs[2]] });
      expect(saveFileTabs(storage, [...partition.matching, ...partition.recovery]).ok).toBe(true);
      expect(loadFileTabs(storage)).toEqual({ ok: true, tabs });
    }
  });

  it("preserves base content and revision, including empty strings, across storage reloads", () => {
    const storage = memoryStorage();
    const tabs = [tab, { ...tab, path: "empty.txt", baseContent: "", baseRevision: "" }];
    expect(saveFileTabs(storage, tabs)).toEqual({ ok: true, tabs });
    expect(loadFileTabs(storage)).toEqual({ ok: true, tabs });
    expect(partitionFileTabs(tabs, binding)).toEqual({ matching: tabs, recovery: [] });
  });

  it("marks old dirty drafts for recovery and never makes them safe by confirming a root", () => {
    const legacy = { binding, path: "old.txt", draft: "unsaved old content", dirty: true };
    const clean = { binding, path: "clean.txt", draft: "", dirty: false };
    const raw = JSON.stringify({ version: 1, tabs: [legacy, clean] });
    const storage = memoryStorage();
    storage.setItem("herdr.files.tabs.v1", raw);
    const recovered = { ...legacy, needsRecovery: true };
    expect(loadFileTabs(storage)).toEqual({ ok: true, tabs: [recovered, clean] });
    expect(partitionFileTabs([legacy], binding)).toEqual({ matching: [], recovery: [recovered] });
    const restarted = { ...binding, bindingIdentity: "new-generation" };
    expect(partitionFileTabs([recovered, clean], restarted, true)).toEqual({
      matching: [{ ...clean, binding: restarted }], recovery: [recovered],
    });
    expect(saveFileTabs(storage, [recovered, clean]).ok).toBe(true);
    expect(loadFileTabs(storage)).toEqual({ ok: true, tabs: [recovered, clean] });
  });

  it("rejects incomplete, conflicting, or incorrectly typed base metadata without writing", () => {
    const badTabs = [
      { ...tab, baseRevision: undefined },
      { ...tab, baseContent: undefined },
      { ...tab, baseRevision: 1 },
      { ...tab, baseContent: null },
      { ...tab, needsRecovery: true },
      { ...tab, needsRecovery: false },
      { binding, path: "clean.txt", draft: "", dirty: false, needsRecovery: true },
      { binding, path: "clean.txt", draft: "", dirty: false, baseContent: "x", baseRevision: "r" },
    ];
    for (const bad of badTabs) {
      let writes = 0;
      const storage = { getItem: () => null, setItem: () => { writes += 1; } };
      const tabs = [bad] as FileTab[];
      expect(deserializeFileTabs(JSON.stringify({ version: 1, tabs }))).toEqual({ ok: false, error: "invalid-data" });
      expect(saveFileTabs(storage, tabs)).toEqual({ ok: false, error: "invalid-data", tabs });
      expect(writes).toBe(0);
    }
  });

  it("rejects malformed persisted data instead of silently treating it as empty", () => {
    for (const raw of ["{", "null", "{}", '{"version":2,"tabs":[]}', '{"version":1,"tabs":[{}]}', JSON.stringify({ version: 1, tabs: [{ ...tab, dirty: "true" }] })]) {
      expect(deserializeFileTabs(raw)).toEqual({ ok: false, error: "invalid-data" });
      expect(loadFileTabs({ getItem: () => raw, setItem: () => {} })).toEqual({ ok: false, error: "invalid-data" });
    }
    expect(deserializeFileTabs(serializeFileTabs([tab, tab]))).toEqual({ ok: false, error: "invalid-data" });
    expect(saveFileTabs(memoryStorage(), [tab, tab])).toEqual({ ok: false, error: "invalid-data", tabs: [tab, tab] });
    expect(loadFileTabs(memoryStorage())).toEqual({ ok: true, tabs: [] });
  });

  it("reports unavailable and throwing storage without losing in-memory tabs", () => {
    const tabs = [tab];
    expect(loadFileTabs(null)).toEqual({ ok: false, error: "storage-unavailable" });
    expect(saveFileTabs(null, tabs)).toEqual({ ok: false, error: "storage-unavailable", tabs });
    const inaccessible = () => { throw new Error("getter denied"); };
    expect(loadFileTabs(inaccessible)).toEqual({ ok: false, error: "storage-read-failed" });
    expect(saveFileTabs(inaccessible, tabs)).toEqual({ ok: false, error: "storage-write-failed", tabs });
    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(loadFileTabs(denied)).toEqual({ ok: false, error: "storage-read-failed" });
    const result = saveFileTabs(denied, tabs);
    expect(result).toEqual({ ok: false, error: "storage-write-failed", tabs });
    expect(result.tabs[0].draft).toBe("unsaved");
  });
});
