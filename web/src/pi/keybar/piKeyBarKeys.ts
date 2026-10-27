import type { PiBridgeStatus } from "../piClient";
import type { PiBusy } from "../piProtocol";

/**
 * One Key Bar key: a label a thumb can read plus the exact bytes Pi receives.
 * Every sequence comes from the shared mobile terminal key encodings, so the
 * Key Bar and the Chord Composer can never drift apart.
 */
export interface PiKeyBarKey {
  id: string;
  label: string;
  ariaLabel: string;
  data: string;
}

/** Escape aborts the current run. */
const ABORT = "\x1B";
/** Enter steers the running turn with the Composer's draft. */
const ENTER = "\r";
/** Alt+Enter queues the Composer's draft as a follow-up after the run. */
const QUEUE = "\x1B\r";
/** Shift+Tab cycles the thinking level. */
const SHIFT_TAB = "\x1B[Z";
/** Ctrl+O collapses or expands tool output. */
const CTRL_O = "\x0F";
const UP = "\x1B[A";
const DOWN = "\x1B[B";
const SPACE = " ";

/**
 * Idle keys match Pi's own hints: command and file prefixes, shell mode,
 * thinking level, tool output and history.
 */
const IDLE_KEYS: readonly PiKeyBarKey[] = [
  { id: "slash", label: "/", ariaLabel: "Command", data: "/" },
  { id: "at", label: "@", ariaLabel: "File", data: "@" },
  { id: "bang", label: "!", ariaLabel: "Shell command", data: "!" },
  { id: "thinking", label: "⇥", ariaLabel: "Cycle thinking level", data: SHIFT_TAB },
  { id: "tools", label: "⌃O", ariaLabel: "Toggle tool output", data: CTRL_O },
  { id: "history", label: "↑", ariaLabel: "Previous prompt", data: UP },
];

/** While Pi works, the only useful inputs are abort, steer and queue. */
const BUSY_KEYS: readonly PiKeyBarKey[] = [
  { id: "abort", label: "Stop", ariaLabel: "Abort the current run", data: ABORT },
  { id: "steer", label: "Steer", ariaLabel: "Steer the current run", data: ENTER },
  { id: "queue", label: "Queue", ariaLabel: "Queue a follow-up", data: QUEUE },
  { id: "tools", label: "⌃O", ariaLabel: "Toggle tool output", data: CTRL_O },
];

/** A dialog owns the keyboard: arrows move, Enter picks, Esc and Space dismiss. */
const DIALOG_KEYS: readonly PiKeyBarKey[] = [
  { id: "up", label: "↑", ariaLabel: "Previous choice", data: UP },
  { id: "down", label: "↓", ariaLabel: "Next choice", data: DOWN },
  { id: "confirm", label: "Enter", ariaLabel: "Confirm choice", data: ENTER },
  { id: "escape", label: "Esc", ariaLabel: "Cancel dialog", data: ABORT },
  { id: "space", label: "Space", ariaLabel: "Toggle choice", data: SPACE },
];

const KEYS_BY_STATE: Record<PiBusy, readonly PiKeyBarKey[]> = {
  idle: IDLE_KEYS,
  busy: BUSY_KEYS,
  dialog: DIALOG_KEYS,
};

/**
 * The Key Bar follows Pi State, and falls back to the idle set whenever the Pi
 * Bridge is not online, so an unreachable pane still offers its usual keys.
 */
export function piKeyBarState(status: PiBridgeStatus, busy: PiBusy | null): PiBusy {
  if (status !== "online" || busy === null) {
    return "idle";
  }
  return busy;
}

/** Ordered keys for one Pi State; the returned array is never empty. */
export function piKeyBarKeys(state: PiBusy): readonly PiKeyBarKey[] {
  return KEYS_BY_STATE[state] ?? IDLE_KEYS;
}