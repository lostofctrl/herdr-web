import { useCallback, useState } from "react";

const STORAGE_PREFIX = "herdr.pi-mode.composer-draft";

/** Stable per-bridge, per-pane draft identity so drafts survive pane switches and reloads. */
export function piComposerDraftKey(bridgeId: string, paneId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(bridgeId)}:${encodeURIComponent(paneId)}`;
}

function storageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
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
  if (!storage) {
    return;
  }
  const prefix = `${STORAGE_PREFIX}:${encodeURIComponent(bridgeId)}:`;
  const live = new Set(paneIds.map((paneId) => piComposerDraftKey(bridgeId, paneId)));
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
