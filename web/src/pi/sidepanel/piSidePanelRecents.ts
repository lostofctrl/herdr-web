const STORAGE_KEY = "herdr.pi.side-panel.recents";
const MAX_RECENTS = 100;

export function readRecentPiTriggers(): string[] {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored)
      ? [...new Set(stored.filter((value): value is string => typeof value === "string"))].slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

export function rememberPiTrigger(trigger: string, recents: string[]): string[] {
  const next = [trigger, ...recents.filter((value) => value !== trigger)].slice(0, MAX_RECENTS);
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory order when browser storage is unavailable.
  }
  return next;
}
