import { useCallback, useState } from "react";

const STORAGE_PREFIX = "herdr.pi-mode.composer-draft";
const unresolvedInMemory = new Set<string>();
let lastStorage: Storage | null = null;
const inputMarkerKey = (bridgeId: string, paneId: string) => `${piComposerDraftKey(bridgeId, paneId)}:input-unresolved`;

/** Stable per-bridge, per-pane draft identity so drafts survive pane switches and reloads. */
export function piComposerDraftKey(bridgeId: string, paneId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(bridgeId)}:${encodeURIComponent(paneId)}`;
}

function storageOrNull(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    lastStorage = window.localStorage;
    return lastStorage;
  } catch {
    // Reuse the storage handle, not a second copy of draft text, if its getter fails.
    return lastStorage;
  }
}

export function readPiComposerDraft(
  bridgeId: string,
  paneId: string,
  storage: Storage | null = storageOrNull(),
): string {
  if (!storage) {
    return "";
  }
  try {
    return storage.getItem(piComposerDraftKey(bridgeId, paneId)) ?? "";
  } catch {
    return "";
  }
}

export function writePiComposerDraft(
  bridgeId: string,
  paneId: string,
  value: string,
  storage: Storage | null = storageOrNull(),
) {
  if (!storage) {
    return;
  }
  try {
    if (value) {
      storage.setItem(piComposerDraftKey(bridgeId, paneId), value);
    } else {
      storage.removeItem(piComposerDraftKey(bridgeId, paneId));
    }
  } catch {
    // A full or unavailable storage must never block sending a prompt.
  }
}

/** Input uncertainty shares draft identity/lifetime, never the draft's text payload. */
export function readPiComposerInputUnresolved(bridgeId: string, paneId: string, storage = storageOrNull()): boolean {
  const key = inputMarkerKey(bridgeId, paneId);
  if (unresolvedInMemory.has(key)) return true;
  try {
    const unresolved = storage?.getItem(key) === "1";
    if (unresolved) unresolvedInMemory.add(key);
    return unresolved;
  } catch {
    // An unreadable marker is not proof that terminal input is empty.
    return true;
  }
}

export function writePiComposerInputUnresolved(bridgeId: string, paneId: string, unresolved: boolean, storage = storageOrNull()) {
  const key = inputMarkerKey(bridgeId, paneId);
  if (unresolved) unresolvedInMemory.add(key);
  else unresolvedInMemory.delete(key);
  try {
    if (!storage) return;
    if (unresolved) storage.setItem(key, "1");
    else storage.removeItem(key);
  } catch {
    // Keep uncertainty across remounts even when browser storage is unavailable.
  }
}

/**
 * Clears the stored draft only while it still holds `expected`. A prompt that is
 * already in flight can be superseded by recall or a new draft, and that newer
 * text must survive the delivery while the delivered prompt must not come back
 * on reload.
 */
export function clearPiComposerDraftIf(
  bridgeId: string,
  paneId: string,
  expected: string,
  storage: Storage | null = storageOrNull(),
) {
  if (!storage) {
    return;
  }
  if (readPiComposerDraft(bridgeId, paneId, storage) !== expected) {
    return;
  }
  writePiComposerDraft(bridgeId, paneId, "", storage);
}

/**
 * Drops stored drafts for panes that are gone from a successful, complete
 * bridge snapshot, so closed panes cannot grow browser storage forever.
 * Call only with a current, complete snapshot, like the command draft store.
 */
export function retainPiComposerDrafts(
  bridgeId: string,
  paneIds: readonly string[],
  storage: Storage | null = storageOrNull(),
) {
  const prefix = `${STORAGE_PREFIX}:${encodeURIComponent(bridgeId)}:`;
  const live = new Set(paneIds.flatMap((paneId) => [piComposerDraftKey(bridgeId, paneId), inputMarkerKey(bridgeId, paneId)]));
  for (const key of unresolvedInMemory) {
    if (key.startsWith(prefix) && !live.has(key)) unresolvedInMemory.delete(key);
  }
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && !live.has(key)) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      storage.removeItem(key);
    }
  } catch {
    // A read-only or full storage must never break a snapshot update.
  }
}

/**
 * Pi Composer draft that outlives the component: unlike the in-memory command
 * draft store, this survives a reload. Mount the Composer with a
 * `key` of `bridgeId + paneId` so switching panes re-reads the right draft.
 *
 * The third setter changes the draft without touching storage, for text the user
 * has not authored in this visit — recalling a sent prompt must not write an old
 * prompt back to disk.
 */
export function usePiComposerDraft(bridgeId: string, paneId: string) {
  const [value, setValue] = useState(() => readPiComposerDraft(bridgeId, paneId));
  const update = useCallback(
    (next: string) => {
      setValue(next);
      writePiComposerDraft(bridgeId, paneId, next);
    },
    [bridgeId, paneId],
  );
  return [value, update, setValue] as const;
}
