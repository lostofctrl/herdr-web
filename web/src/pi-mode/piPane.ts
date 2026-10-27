import { agentIconKind } from "../AgentIcon";
import type { PaneInfo } from "../types";

/**
 * Pi mode registers from the same agent-type seam the pane icons already use,
 * so a pane is a Pi Pane exactly when herdr-web would draw the Pi icon for it.
 */
export function isPiPane(pane: PaneInfo | null | undefined): boolean {
  return Boolean(pane) && agentIconKind(pane as PaneInfo) === "pi";
}
