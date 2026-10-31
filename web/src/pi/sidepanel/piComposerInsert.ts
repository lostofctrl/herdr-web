import { piComposerDraftKey, readPiComposerDraft, readPiComposerInputUnresolved, writePiComposerDraft } from "../../pi-mode/piComposerDraft";

export const PI_COMPOSER_INSERT_EVENT = "herdr:pi-composer-insert";
export type PiComposerInsertResult = "inserted" | "blocked" | "unavailable";
export type PiComposerInsertDetail = { key: string; value: string; text: string; result?: "inserted" };

/**
 * Append a trigger without joining tokens; never submit or discard an existing
 * draft. A mounted Composer owns the live draft and cancels the event after
 * merging the text itself, so the stored draft is only the fallback for a pane
 * whose Composer is not mounted (and never overwrites a recalled prompt).
 */
export function insertPiComposerText(bridgeId: string, paneId: string, text: string): PiComposerInsertResult {
  if (!text || typeof window === "undefined") return "unavailable";
  const key = piComposerDraftKey(bridgeId, paneId);
  const draft = readPiComposerDraft(bridgeId, paneId);
  const value = `${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${text}`;
  const detail: PiComposerInsertDetail = { key, value, text };
  const handled = !window.dispatchEvent(new CustomEvent<PiComposerInsertDetail>(PI_COMPOSER_INSERT_EVENT, {
    cancelable: true,
    detail,
  }));
  if (handled) return detail.result === "inserted" ? "inserted" : "blocked";
  try {
    // The draft helpers intentionally swallow storage errors. Check the same
    // handle before and after using them so failure cannot look like success.
    const storage = window.localStorage;
    if ((storage.getItem(key) ?? "") !== draft) return "unavailable";
    if (readPiComposerInputUnresolved(bridgeId, paneId, storage)) return "blocked";
    writePiComposerDraft(bridgeId, paneId, value, storage);
    return storage.getItem(key) === value ? "inserted" : "unavailable";
  } catch {
    return "unavailable";
  }
}
