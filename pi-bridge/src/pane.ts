/**
 * Herdr pane detection and per-pane socket path resolution.
 *
 * The bridge is inert outside a Herdr pane. Herdr exposes the pane id in
 * `HERDR_PANE_ID` (verified on Herdr 0.9.3, which also sets HERDR_TAB_ID,
 * HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH and HERDR_ENV).
 *
 * Contract: `$XDG_RUNTIME_DIR/pi-bridge/<HERDR_PANE_ID>.sock`, falling back to
 * `${TMPDIR:-/tmp}/pi-bridge-<uid>/` when `XDG_RUNTIME_DIR` is unset.
 */
import os from "node:os";
import path from "node:path";

export type BridgeEnv = Record<string, string | undefined>;

export function resolveSocketPath(env: BridgeEnv): string | null {
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) {
    return null;
  }
  // Never let a pane id escape the runtime directory.
  if (paneId.includes("/") || paneId.includes("\\") || paneId.includes("..")) {
    return null;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const socketDir = runtimeDir
    ? path.join(runtimeDir, "pi-bridge")
    : path.join(os.tmpdir(), `pi-bridge-${currentUid()}`);
  return path.join(socketDir, `${paneId}.sock`);
}

function currentUid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}
