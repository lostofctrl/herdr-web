/**
 * Per-pane prompt recall kept only in memory: prompts can contain secrets, so
 * nothing here is written to localStorage or sent anywhere.
 */
const MAX_ENTRIES = 50;
const MAX_BYTES = 16 * 1024;
const histories = new Map<string, string[]>();

function key(bridgeId: string, paneId: string) {
  return `${bridgeId}\u0000${paneId}`;
}

function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).length;
}

export function getPiComposerHistory(bridgeId: string, paneId: string): string[] {
  return [...(histories.get(key(bridgeId, paneId)) ?? [])];
}

export function recordPiComposerHistory(bridgeId: string, paneId: string, text: string) {
  if (text.trim() === "" || utf8Bytes(text) > MAX_BYTES) return;
  const id = key(bridgeId, paneId);
  const entries = histories.get(id) ?? [];
  if (entries[0] === text) return;
  histories.set(id, [text, ...entries].slice(0, MAX_ENTRIES));
}

export function clearPiComposerHistory(bridgeId: string, paneId: string) {
  histories.delete(key(bridgeId, paneId));
}

/** Drops recall for panes that no longer exist, leaving other panes alone. */
export function retainPiComposerHistory(bridgeId: string, paneIds: readonly string[]) {
  const keep = new Set(paneIds.map((paneId) => key(bridgeId, paneId)));
  for (const id of [...histories.keys()]) {
    if (id.startsWith(`${bridgeId}\u0000`) && !keep.has(id)) {
      histories.delete(id);
    }
  }
}
