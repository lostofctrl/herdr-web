export const PI_BRACKETED_PASTE_START = "\x1b[200~";
export const PI_BRACKETED_PASTE_END = "\x1b[201~";

/**
 * A draft can already contain the paste terminators when the user pastes
 * terminal output, a log file, or fetched text. Delivering those bytes verbatim
 * would end the paste early and hand the rest of the prompt to Pi's editor or
 * shell as live keystrokes, so every marker is removed from the payload.
 * Removing a marker can join its neighbors into a new one, so this repeats until
 * no marker is left.
 */
export function stripBracketedPasteMarkers(text: string) {
  let sanitized = text;
  for (;;) {
    const stripped = sanitized
      .split(PI_BRACKETED_PASTE_START)
      .join("")
      .split(PI_BRACKETED_PASTE_END)
      .join("");
    if (stripped === sanitized) {
      return sanitized;
    }
    sanitized = stripped;
  }
}

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
 * characters stay inside the paste and are never executed line by line, and any
 * paste marker inside the payload is removed so it cannot end the paste early.
 */
export function piComposerDeliveryParts(
  text: string,
  attachmentPaths: string[] = [],
): string[] {
  const promptText = piComposerPromptText(attachmentPaths, text);
  if (promptText.length === 0) {
    return [];
  }
  return [
    `${PI_BRACKETED_PASTE_START}${stripBracketedPasteMarkers(promptText)}${PI_BRACKETED_PASTE_END}`,
    "\r",
  ];
}
