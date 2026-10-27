import { piComposerDraftKey, readPiComposerDraft, writePiComposerDraft } from "../../pi-mode/piComposerDraft";

export const PI_COMPOSER_INSERT_EVENT = "herdr:pi-composer-insert";
export type PiComposerInsertDetail = { key: string; value: string };

/** Append a trigger without joining tokens; never submit or discard an existing draft. */
export function insertPiComposerText(bridgeId: string, paneId: string, text: string): void {
  if (!text) return;
  const draft = readPiComposerDraft(bridgeId, paneId);
  const value = `${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${text}`;
  writePiComposerDraft(bridgeId, paneId, value);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<PiComposerInsertDetail>(PI_COMPOSER_INSERT_EVENT, {
      detail: { key: piComposerDraftKey(bridgeId, paneId), value },
    }));
  }
}
