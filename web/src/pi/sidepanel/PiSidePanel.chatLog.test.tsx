/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PiSidePanel } from "./PiSidePanel";

vi.mock("../PiBridgeContext", () => ({ usePiBridge: () => null }));

it("sends the Kitty-compatible Alt+C key sequence for chat log", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const send = vi.fn().mockReturnValue(true);
  try {
    await act(async () => root.render(<PiSidePanel bridgeId="bridge" paneId="pane" disabled={false} onSend={send} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Toggle Pi Side Panel"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open chat log"]')!.click());
    expect(send).toHaveBeenCalledWith(["\x1b[99;3u"], expect.any(Function));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
