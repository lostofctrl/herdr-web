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
 * Pi Composer draft that outlives the component: unlike the in-memory command
 * draft store, this survives a reload. Mount the Composer with a
 * `key` of `bridgeId + paneId` so switching panes re-reads the right draft.
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
  return [value, update] as const;
}
