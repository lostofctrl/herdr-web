import { piComposerDraftKey, readPiComposerDraft, writePiComposerDraft } from "../../pi-mode/piComposerDraft";

export const PI_COMPOSER_INSERT_EVENT = "herdr:pi-composer-insert";
export type PiComposerInsertDetail = { key: string; value: string; text: string };

/**
 * Append a trigger without joining tokens; never submit or discard an existing
 * draft. A mounted Composer owns the live draft and cancels the event after
 * merging the text itself, so the stored draft is only the fallback for a pane
 * whose Composer is not mounted (and never overwrites a recalled prompt).
 */
export function insertPiComposerText(bridgeId: string, paneId: string, text: string): void {
  if (!text) return;
  const draft = readPiComposerDraft(bridgeId, paneId);
  const value = `${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${text}`;
  let handled = false;
  if (typeof window !== "undefined") {
    handled = !window.dispatchEvent(new CustomEvent<PiComposerInsertDetail>(PI_COMPOSER_INSERT_EVENT, {
      cancelable: true,
      detail: { key: piComposerDraftKey(bridgeId, paneId), value, text },
    }));
  }
  if (!handled) writePiComposerDraft(bridgeId, paneId, value);
}
