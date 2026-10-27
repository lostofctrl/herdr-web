export const PI_BRACKETED_PASTE_START = "\x1b[200~";
export const PI_BRACKETED_PASTE_END = "\x1b[201~";

/**
 * The prompt Pi receives. Uploaded image paths go first, space-separated and in
 * chip order, then the draft text. Pi's editor keeps the paths as plain prompt
 * text, so Pi decides what to do with them exactly as with a pasted file path.
 */
export function piComposerPromptText(attachmentPaths: string[], draft: string): string {
  const paths = attachmentPaths.filter((path) => path.length > 0).join(" ");
  if (!paths) {
    return draft;
  }
  return draft ? `${paths} ${draft}` : paths;
}

/**
 * Delivery is one bracketed paste of the complete draft (uploaded image paths
 * first) followed by a separate Enter, so Pi's own editor decides between
 * prompt, steer, follow-up, `/command` and `!bash`. Newlines and special
 * characters stay inside the paste and are never executed line by line.
 */
export function piComposerDeliveryParts(
  text: string,
  attachmentPaths: string[] = [],
): string[] {
  const promptText = piComposerPromptText(attachmentPaths, text);
  if (promptText.length === 0) {
    return [];
  }
  return [`${PI_BRACKETED_PASTE_START}${promptText}${PI_BRACKETED_PASTE_END}`, "\r"];
}
