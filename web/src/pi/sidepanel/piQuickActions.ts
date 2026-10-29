import { PI_ESCAPE_KEY } from "../piKeys";
import { piComposerDeliveryParts } from "../../pi-mode/piComposerDelivery";

/** Shared Side Panel/Composer inventory; all commands use the existing PTY path. */
export const PI_QUICK_ACTIONS = [
  { label: "Abort Pi", title: "Abort", command: null },
  { label: "Compact Pi session", title: "Compact", command: "/compact" },
  { label: "New Pi session", title: "New session", command: "/new" },
  { label: "Resume Pi session", title: "Resume", command: "/resume" },
] as const;

export function piQuickActionParts(command: string | null): string[] {
  return command === null ? [PI_ESCAPE_KEY] : piComposerDeliveryParts(command);
}
