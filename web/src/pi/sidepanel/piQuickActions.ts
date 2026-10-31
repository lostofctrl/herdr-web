import { Archive, CircleStop, History, Plus, type LucideIcon } from "lucide-react";
import { PI_ESCAPE_KEY } from "../piKeys";
import { piComposerDeliveryParts } from "../../pi-mode/piComposerDelivery";

type PiQuickAction = { label: string; title: string; command: string | null; icon: LucideIcon };

/** Shared Side Panel/Composer inventory; all commands use the existing PTY path. */
export const PI_QUICK_ACTIONS: readonly PiQuickAction[] = [
  { label: "Abort Pi", title: "Abort", command: null, icon: CircleStop },
  { label: "Compact Pi session", title: "Compact", command: "/compact", icon: Archive },
  { label: "New Pi session", title: "New session", command: "/new", icon: Plus },
  { label: "Resume Pi session", title: "Resume", command: "/resume", icon: History },
];

export function piQuickActionParts(command: string | null): string[] {
  return command === null ? [PI_ESCAPE_KEY] : piComposerDeliveryParts(command);
}
