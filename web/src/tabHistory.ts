export type TabVisit = { bridgeId: string; tabId: string };
export type TabHistory = { entries: TabVisit[]; index: number };

const KEY = "herdrWeb.tabHistory.v1";
const LIMIT = 100;
const emptyHistory = (): TabHistory => ({ entries: [], index: -1 });

export function sameTabVisit(a: TabVisit | undefined, b: TabVisit): boolean {
  return a?.bridgeId === b.bridgeId && a.tabId === b.tabId;
}

export function appendTabVisit(history: TabHistory, visit: TabVisit): TabHistory {
  if (sameTabVisit(history.entries[history.index], visit)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), visit].slice(-LIMIT);
  return { entries, index: entries.length - 1 };
}

export function findTabVisit(history: TabHistory, direction: -1 | 1, available: (visit: TabVisit) => boolean): number {
  for (let i = history.index + direction; i >= 0 && i < history.entries.length; i += direction) {
    if (available(history.entries[i])) return i;
  }
  return -1;
}

function localStorageOrNull(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readTabHistory(storage: Pick<Storage, "getItem"> | null = localStorageOrNull()): TabHistory {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return emptyHistory();
    const { entries, index } = parsed as { entries?: unknown; index?: unknown };
    if (!Array.isArray(entries) || entries.length > LIMIT || !Number.isInteger(index) ||
        (index as number) < -1 || (index as number) >= entries.length ||
        (entries.length > 0 && (index as number) < 0) ||
        !entries.every((entry: unknown) => entry && typeof entry === "object" &&
          typeof (entry as TabVisit).bridgeId === "string" && !!(entry as TabVisit).bridgeId &&
          typeof (entry as TabVisit).tabId === "string" && !!(entry as TabVisit).tabId)) return emptyHistory();
    return { entries: entries.map(({ bridgeId, tabId }) => ({ bridgeId, tabId })), index: index as number };
  } catch { return emptyHistory(); }
}

export function writeTabHistory(history: TabHistory, storage: Pick<Storage, "setItem"> | null = localStorageOrNull()): void {
  try { storage?.setItem(KEY, JSON.stringify(history)); } catch { /* Storage may be unavailable. */ }
}
