/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PiSidePanel, PiSidePanelContent } from "./PiSidePanel";
import { readPiComposerDraft, writePiComposerDraft } from "../../pi-mode/piComposerDraft";
import { defaultPiSidePanelButtons } from "./piSidePanelButtons";

/**
 * The terminal aside and the Composer's floating panel must show one Side
 * Panel. Both render `PiSidePanelContent`, so this test pins that the two
 * shells expose the same controls — a copy that drifts would fail here.
 */

const bridge = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../PiBridgeContext", () => ({ usePiBridge: () => bridge.current }));

const api = {
  paneId: "pane",
  status: "online",
  state: { model: null, models: [], thinking_level: "medium", thinking_levels: ["low", "medium", "high"], busy: "idle" },
  catalog: {
    commands: [{ name: "compact", description: "Compact the session now", source: "builtin" }],
    skills: [{ name: "graft", description: "Repo context graph", source: "skill" }],
    skills_note: undefined,
  },
  capabilities: { list_files: true, skills_catalog: true },
  setModel: vi.fn(async () => {}),
  setThinkingLevel: vi.fn(async () => {}),
};

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  bridge.current = api;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

function labels(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[aria-label]")]
    .map((element) => element.getAttribute("aria-label"))
    .filter((label) => label !== "Toggle Pi Side Panel" && label !== "Close Pi Side Panel" && label !== "Pi Side Panel")
    .sort();
}

it("reports a blocked catalog insertion instead of recording it", async () => {
  const reject = (event: Event) => event.preventDefault();
  window.addEventListener("herdr:pi-composer-insert", reject);
  try {
    const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={() => true} />);
    await act(async () => content.querySelector<HTMLButtonElement>('[aria-label="Insert /compact"]')!.click());
    expect(content.querySelector('[role="alert"]')?.textContent).toMatch(/blocked|pending|recover/i);
    expect(window.localStorage.length).toBe(0);
  } finally { window.removeEventListener("herdr:pi-composer-insert", reject); }
});

it("reports when an action cannot be queued", async () => {
  const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={() => false} />);
  await act(async () => content.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')!.click());
  expect(content.querySelector('[role="alert"]')?.textContent).toMatch(/could not|unavailable|blocked/i);
});

it("runs custom insert and send actions without sending or replacing the draft", async () => {
  const state = { ...defaultPiSidePanelButtons(), buttons: [
    { id: "custom-insert", title: "Insert prompt", icon: { type: "glyph", text: "✨" }, action: { type: "prompt", text: "/skill:review check", delivery: "insert" } },
    { id: "custom-send", title: "Send prompt", icon: { type: "lucide", name: "star" }, action: { type: "prompt", text: "run once", delivery: "send" } },
  ], pinned: ["custom-insert", "custom-send"] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(
    String(url).endsWith("capabilities") ? { pi_sidepanel_buttons_version: 1 } : state,
  )));
  writePiComposerDraft("bridge", "pane", "Existing draft");
  const send = vi.fn((_: string[], done?: (delivered: number, total: number) => void) => { done?.(2, 2); return true; });
  const url = (path: string) => `https://selected.example/proxy${path}`;
  const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} httpUrl={url} onSend={send} />);
  await act(async () => content.querySelector<HTMLButtonElement>('[aria-label="Insert prompt"]')!.click());
  expect(readPiComposerDraft("bridge", "pane")).toBe("Existing draft\n/skill:review check");
  expect(send).not.toHaveBeenCalled();
  await act(async () => content.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click());
  expect(send).toHaveBeenCalledWith(["\x1b[200~run once\x1b[201~", "\r"], expect.any(Function));
  expect(readPiComposerDraft("bridge", "pane")).toBe("Existing draft\n/skill:review check");
  expect(content.textContent).toContain("Pi execution is not confirmed");
});

it("explains terminal-only session, tree and settings access without sending input", async () => {
  const send = vi.fn(() => true);
  const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={send} />);
  const guidance = content.querySelector('[aria-label="Terminal-only Pi controls"]');
  expect(guidance?.textContent).toContain("/resume");
  expect(guidance?.textContent).toContain("/tree");
  expect(guidance?.textContent).toContain("/settings");
  expect(guidance?.textContent).toMatch(/terminal/i);
  expect(send).not.toHaveBeenCalled();
});

it("directs BTW conversations to the terminal when the command is available", async () => {
  const send = vi.fn(() => true);
  bridge.current = {
    ...api,
    catalog: { ...api.catalog, commands: [...api.catalog.commands, { name: "btw", description: "Side conversation", source: "extension" }] },
  };
  const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={send} />);
  const guidance = content.querySelector('[aria-label="BTW terminal guidance"]');
  expect(guidance?.textContent).toMatch(/\/btw/);
  expect(guidance?.textContent).toMatch(/terminal/i);
  expect(guidance?.textContent).toMatch(/browser.+not available/i);
  expect(send).not.toHaveBeenCalled();
});

it("does not advertise BTW when it is absent from the command catalog", async () => {
  const content = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={() => true} />);
  expect(content.querySelector('[aria-label="BTW terminal guidance"]')).toBeNull();
});

it("renders the same Side Panel controls in the terminal aside and the Composer panel", async () => {
  const send = vi.fn(() => true);
  const aside = await render(<PiSidePanel bridgeId="bridge" paneId="pane" disabled={false} onSend={send} />);
  await act(async () => aside.querySelector<HTMLButtonElement>('[aria-label="Toggle Pi Side Panel"]')!.click());
  const floatingBody = await render(<PiSidePanelContent bridgeId="bridge" paneId="pane" disabled={false} onSend={send} />);

  expect(labels(aside)).toEqual(labels(floatingBody));
  expect(labels(aside)).toContain("Insert /compact");
  expect(labels(aside)).toContain("Insert /skill:graft");
  expect(labels(aside)).toContain("Pi thinking level");
  expect(labels(aside)).toContain("Open chat log");
});
