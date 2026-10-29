/** How long a just-cleared command field keeps rejecting delayed composition edits. */
export const COMMAND_FIELD_COMPOSITION_GUARD_MS = 250;

/** Deadline used by a field that cleared its value but may still receive IME edits. */
export function compositionGuardDeadline(now = performance.now()) {
  return now + COMMAND_FIELD_COMPOSITION_GUARD_MS;
}

function isCompositionInput(event: Event): boolean {
  if (typeof InputEvent === "undefined" || !(event instanceof InputEvent)) {
    return false;
  }
  return (
    event.isComposing ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition" ||
    event.inputType === "deleteCompositionText"
  );
}

/**
 * Native composition edits may arrive after a field was cleared and are not
 * always cancelable, so they must be rejected instead of restoring sent text.
 */
export function isLateCompositionEdit(
  event: Event | null | undefined,
  guardUntil: number,
  now = performance.now(),
): boolean {
  return now < guardUntil && Boolean(event) && isCompositionInput(event as Event);
}
