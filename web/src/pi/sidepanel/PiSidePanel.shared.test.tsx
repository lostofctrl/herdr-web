/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PiSidePanel, PiSidePanelContent } from "./PiSidePanel";

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
