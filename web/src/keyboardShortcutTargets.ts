/**
 * Shared guards for app-wide keyboard shortcuts, so a shortcut owned by a pane
 * never steals keys from a text field, a dialog, or a contenteditable editor.
 */
export function isShortcutTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

export function hasOpenModal() {
  return document.querySelector(".overlay-root [role='dialog']") !== null;
}

export function hasOpenMenu() {
  return document.querySelector('[role="menu"]') !== null;
}
