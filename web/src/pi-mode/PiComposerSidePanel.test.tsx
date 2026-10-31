/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiComposer } from "./PiComposer";
import { PI_ESCAPE_KEY } from "../pi/piKeys";
import { retainPiComposerDrafts } from "./piComposerDraft";

/**
 * The Composer floats the Side Panel instead of hosting a second copy of its
 * view: these tests pin the shared body, draft-only catalog insertion and the
 * dismissal rules that a floating panel owns.
 */

vi.mock("../pi/screenshot", () => ({
  ScreenshotEditor: () => null,
}));

const bridge = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("../pi/PiBridgeContext", () => ({
  usePiBridge: () => bridge.current,
}));

const api = {
  paneId: "pane-a",
  status: "online",
  state: {
    model: null,
    models: [],
    thinking_level: "medium",
    thinking_levels: ["low", "medium", "high"],
    busy: "idle",
  },
  catalog: {
    commands: [{ name: "compact", description: "Compact the session now", source: "builtin" }],
    skills: [{ name: "graft", description: "Repo context graph", source: "skill" }],
    skills_note: undefined,
  },
  capabilities: { list_files: true, skills_catalog: true },
  dialogs: [],
  setModel: vi.fn(async () => {}),
  setThinkingLevel: vi.fn(async () => {}),
  listFiles: vi.fn(async () => []),
  answerDialog: vi.fn(async () => ({ accepted: true })),
  resync: vi.fn(),
};

const roots: Root[] = [];

beforeEach(() => {
  window.localStorage.clear();
  bridge.current = api;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  retainPiComposerDrafts("bridge-1", []);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderComposer(props: Partial<Parameters<typeof PiComposer>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onSend = vi.fn(
    (parts: string[], onDelivered: (deliveredParts: number, totalParts: number) => void) => {
      onDelivered(parts.length, parts.length);
      return true;
    },
  );
  await act(async () =>
    root.render(
      <PiComposer
        bridgeId="bridge-1"
        paneId="pane-a"
        mobile={false}
        active
        disabled={false}
        onSend={onSend}
        onUploadImages={vi.fn(async () => [])}
        onTerminalFocus={() => {}}
        onControlsHeightChange={() => {}}
        {...props}
      />,
    ));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
  return { container, onSend };
}

async function openPanel(container: HTMLElement) {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Toggle Pi Side Panel"]')!.click());
  return panel(container);
}

function panel(container: HTMLElement) {
  const found = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Pi Side Panel"]');
  if (!found) throw new Error("Side Panel is not floating in the Composer");
  return found;
}

function promptField(container: HTMLElement) {
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Pi prompt"]');
  if (!field) throw new Error("Missing Pi Composer field");
  return field;
}

describe("Composer Side Panel", () => {
  it("floats the shared Side Panel view from a Composer control", async () => {
    const { container } = await renderComposer();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Toggle Pi Side Panel"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    const floating = await openPanel(container);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Same body as the terminal aside: model, thinking, quick actions, catalog.
    expect(floating.querySelector('[aria-label="Pi thinking level"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Abort Pi"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Open chat log"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Search commands and skills"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Insert /compact"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Insert /skill:graft"]')).not.toBeNull();
  });

  it("inserts a catalog entry into the draft without sending", async () => {
    const { container, onSend } = await renderComposer();
    const floating = await openPanel(container);
    await act(async () => floating.querySelector<HTMLButtonElement>('[aria-label="Insert /compact"]')!.click());
    expect(promptField(container).value).toContain("/compact");
    expect(onSend).not.toHaveBeenCalled();
    // The panel stays open so a second trigger can be picked.
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).not.toBeNull();
  });

  it("sends quick actions through the existing PI escape/command path", async () => {
    const { container, onSend } = await renderComposer();
    const floating = await openPanel(container);
    await act(async () => floating.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')!.click());
    expect(onSend).toHaveBeenCalledWith([PI_ESCAPE_KEY], expect.any(Function));
    expect(promptField(container).value).toBe("");
  });

  it("closes from its control, Escape and an outside pointerdown", async () => {
    const { container } = await renderComposer();

    let floating = await openPanel(container);
    await act(async () => floating.querySelector<HTMLButtonElement>('[aria-label="Close Pi Side Panel"]')!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).toBeNull();

    floating = await openPanel(container);
    await act(async () => {
      floating.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).toBeNull();

    await openPanel(container);
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).toBeNull();
  });

  it("does not dismiss the floating panel for events inside a portaled button manager", async () => {
    const { container } = await renderComposer();
    const floating = await openPanel(container);
    const backdrop = document.createElement("div");
    backdrop.className = "pi-button-manager-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "pi-button-manager-dialog";
    backdrop.append(dialog);
    document.body.append(backdrop);
    try {
      await act(async () => dialog.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(container.contains(floating)).toBe(true);
    } finally {
      backdrop.remove();
    }
  });

  it("closes the nested button manager before the floating panel on Escape", async () => {
    const { container } = await renderComposer();
    const floating = await openPanel(container);
    const trigger = floating.querySelector<HTMLButtonElement>('[aria-label="More Pi buttons"]')!;
    await act(async () => trigger.click());
    const manage = [...floating.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === "Manage Pi buttons")!;
    await act(async () => manage.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Manage Pi buttons"]')!;
    expect(dialog).not.toBeNull();
    expect(floating.contains(dialog)).toBe(false);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.body.querySelector('[role="dialog"][aria-label="Manage Pi buttons"]')).toBeNull();
    expect(container.contains(floating)).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps one Composer popup at a time and closes with the Composer", async () => {
    const { container } = await renderComposer();
    await openPanel(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open prompt history"]')!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).toBeNull();

    await openPanel(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Composer (Esc)"]')!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Pi Side Panel"]')).toBeNull();
  });

  it("offers the same floating panel on the mobile Composer", async () => {
    const { container } = await renderComposer({ mobile: true });
    const floating = await openPanel(container);
    expect(floating.querySelector('[aria-label="Search commands and skills"]')).not.toBeNull();
    expect(floating.querySelector('[aria-label="Abort Pi"]')).not.toBeNull();
  });
});
