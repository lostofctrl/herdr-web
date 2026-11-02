import type { FileWatchEvent } from "./fileApi";

export interface WatchLoopOptions {
  /** Opens one stream; resolves when the bridge closes it and rejects on failure. */
  start: (signal: AbortSignal, onEvent: (event: FileWatchEvent) => void) => Promise<void>;
  onEvent: (event: FileWatchEvent) => void;
  /** A stream end may just be the bridge's lifetime cap, so reconnect unless stopped. */
  delayMs?: number;
  attempts?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Notified when the loop gives up, so the caller can show a degraded state. */
  onStop?: (reason: "exhausted" | "unavailable") => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** A stale binding or unavailable capability is terminal; anything else is retried. */
function isTerminal(message: unknown): boolean {
  return typeof message === "string" && (message === "binding_mismatch" || message === "invalid_path");
}

/**
 * Keeps a change stream open by resubscribing after the bridge closes it. Every
 * reconnect is a full resynchronization opportunity, so a consumer must treat the
 * first event after a reconnect as authoritative rather than incremental.
 */
export function watchWithRetry(options: WatchLoopOptions): () => void {
  const { start, onEvent, delayMs = 2_000, attempts = 5, sleep = defaultSleep, onStop } = options;
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    let remaining = attempts;
    while (!stopped && !controller.signal.aborted) {
      try {
        await start(controller.signal, onEvent);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
        if (isTerminal(code)) break;
        if (controller.signal.aborted) break;
      }
      if (stopped || controller.signal.aborted) break;
      remaining -= 1;
      if (remaining <= 0) {
        onStop?.("exhausted");
        break;
      }
      await sleep(delayMs, controller.signal);
    }
  })();
  return () => { stopped = true; controller.abort(); };
}
