import { describe, expect, it, vi } from "vitest";
import { watchWithRetry } from "./fileWatchRetry";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watchWithRetry", () => {
  it("resubscribes when the bridge closes the stream, then stops on demand", async () => {
    const start = vi.fn(async () => {});
    const stop = watchWithRetry({ start, onEvent: () => {}, attempts: 3, sleep: async () => {} });
    await flush(); await flush(); await flush();
    expect(start.mock.calls.length).toBe(3);
    stop();
    await flush();
    expect(start.mock.calls.length).toBe(3);
  });

  it("delivers every hint and reports exhaustion instead of looping forever", async () => {
    const hint = { kind: "change", name: "a.txt" } as const;
    const onStop = vi.fn();
    const start = vi.fn(async (_signal: AbortSignal, onEvent: (event: typeof hint) => void) => { onEvent(hint); });
    watchWithRetry({ start, onEvent: (event) => expect(event).toEqual(hint), attempts: 2, sleep: async () => {}, onStop });
    for (let index = 0; index < 6; index += 1) await flush();
    expect(onStop).toHaveBeenCalledWith("exhausted");
  });

  it("stops immediately for a stale binding and never retries", async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error("stale"), { code: "binding_mismatch" }); });
    const onStop = vi.fn();
    watchWithRetry({ start, onEvent: () => {}, attempts: 5, sleep: async () => {}, onStop });
    await flush(); await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("retries transient failures with the configured delay", async () => {
    const sleep = vi.fn(async () => {});
    const start = vi.fn(async () => { throw new Error("network_error"); });
    const stop = watchWithRetry({ start, onEvent: () => {}, attempts: 4, sleep });
    await flush(); await flush(); await flush();
    stop();
    expect(sleep).toHaveBeenCalled();
    expect(start.mock.calls.length).toBeGreaterThan(1);
  });
});
