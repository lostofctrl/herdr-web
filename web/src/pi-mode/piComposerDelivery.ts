export const PI_BRACKETED_PASTE_START = "\x1b[200~";
export const PI_BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Delivery is one bracketed paste of the complete draft followed by a separate
 * Enter, so Pi's own editor decides between prompt, steer, follow-up,
 * `/command` and `!bash`. Newlines and special characters stay inside the
 * paste and are never executed line by line.
 */
export function piComposerDeliveryParts(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return [`${PI_BRACKETED_PASTE_START}${text}${PI_BRACKETED_PASTE_END}`, "\r"];
}
