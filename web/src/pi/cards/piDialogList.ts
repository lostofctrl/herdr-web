import type { PiDialog } from "../piProtocol";

/**
 * The dialogs one Pi Pane should show as Native Cards, in arrival order:
 * question dialogs always, wrapped generic dialogs only when the bridge
 * installed the `ctx.ui` wrap, and each dialog id at most once.
 */
export function visiblePiDialogs(dialogs: readonly PiDialog[], genericEnabled: boolean): PiDialog[] {
  const seen = new Set<string>();
  const visible: PiDialog[] = [];
  for (const dialog of dialogs) {
    if (seen.has(dialog.id)) {
      continue;
    }
    if (dialog.kind !== "question" && !genericEnabled) {
      continue;
    }
    seen.add(dialog.id);
    visible.push(dialog);
  }
  return visible;
}
