import { CircleStop, FilePlus, FolderOpen, Minimize2 } from "lucide-react";
import { PI_ESCAPE_KEY } from "../piKeys";
import { piComposerDeliveryParts } from "../../pi-mode/piComposerDelivery";

/** Shared Side Panel/Composer inventory; all commands use the existing PTY path. */
export const PI_QUICK_ACTIONS = [
  { label: "Abort Pi", title: "Abort", command: null, icon: CircleStop },
  { label: "Compact Pi session", title: "Compact", command: "/compact", icon: Minimize2 },
  { label: "New Pi session", title: "New session", command: "/new", icon: FilePlus },
  { label: "Resume Pi session", title: "Resume", command: "/resume", icon: FolderOpen },
] as const;

export function piQuickActionParts(command: string | null): string[] {
  return command === null ? [PI_ESCAPE_KEY] : piComposerDeliveryParts(command);
}
