/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
import { TerminalView } from "./TerminalView";
import type { PaneInfo } from "./types";

const renderer = vi.hoisted(() => ({
  mount: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  fit: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  refreshMetrics: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  clearSelection: vi.fn(),
  setFontSize: vi.fn(),
  setScrollSensitivity: vi.fn(),
  setTapFocusHandler: vi.fn(),
  setMobileTouchSelection: vi.fn(),
  setAccessibleScreenListener: vi.fn(),
  focusTextInput: vi.fn(),
  focus: vi.fn(),
  onInput: vi.fn(),
  onScroll: vi.fn(),
}));
vi.mock("./terminalRenderer", () => ({
  GhosttyRenderer: class {
    constructor() {
      return renderer;
    }
  },
}));
vi.mock("./native", () => ({ addNativeResumeHandler: () => () => {} }));

class TestSocket extends EventTarget {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 1;
  readonly url: string;
  send = vi.fn();
  close = vi.fn();
  constructor(url: string) {
    super();
    this.url = url;
    TestSocket.instances.push(this);
  }
}

const BRIDGE_ID = "bridge-1";
const PANE_ID = "pane-a";
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.useFakeTimers();
  TestSocket.instances = [];
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function testPane(agent: string): PaneInfo {
  return {
    pane_id: PANE_ID,
    terminal_id: `${PANE_ID}-terminal`,
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    focused: true,
    agent,
    agent_status: "idle",
    revision: 1,
  };
}

async function renderTerminalView(agent = "pi", mobileControls = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <CommandDraftContext.Provider value={createCommandDraftStore()}>
        <TerminalView
          bridgeId={BRIDGE_ID}
          pane={testPane(agent)}
          connectionKey="test-connection"
          resumeToken={0}
          httpUrl={(path) => path}
          wsUrl={(path, query) => (query ? `${path}?${query}` : path)}
          autoFocus={false}
          mobileControls={mobileControls}
          terminalOutputCoalesceMs={0}
          selected
        />
      </CommandDraftContext.Provider>,
    );
  });
  if (agent === "pi" && mobileControls) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
  return { container };
}

function terminalSocket() {
  const socket = TestSocket.instances.find((candidate) => candidate.url.startsWith("/ws/terminal"));
  if (!socket) {
    throw new Error("Expected a terminal WebSocket");
  }
  return socket;
}

function piSocket() {
  const socket = TestSocket.instances.find((candidate) => candidate.url.startsWith("/ws/pi"));
  if (!socket) {
    throw new Error("Expected a Pi bridge WebSocket");
  }
  return socket;
}

async function openSockets() {
  const terminal = terminalSocket();
  await act(async () => terminal.dispatchEvent(new Event("open")));
  const pi = piSocket();
  await act(async () => pi.dispatchEvent(new Event("open")));
  await openMobileKeys();
  return { terminal, pi };
}

async function sendPiRecord(record: Record<string, unknown>) {
  await act(async () => {
    piSocket().dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(record) }),
    );
  });
}

async function openMobileKeys() {
  const container = document.body;
  if (container.querySelector(".pi-key-bar")) return;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Terminal keys and Reader"]')?.click());
}

async function showState(busy: "idle" | "busy" | "dialog") {
  await sendPiRecord({
    type: "state",
    busy,
    model: { provider: "anthropic", id: "claude" },
    thinking_level: "medium",
    models: [],
    thinking_levels: ["low", "medium", "high"],
    cwd: "/workspace",
  });
  await openMobileKeys();
}

/** Key Bar keys in order, named by their accessible label. */
function keyLabels(container: HTMLElement) {
  return [...container.querySelectorAll(".pi-key-bar-row button")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
}

/** The visible glyph or word of every key, excluding the trailing chord toggle. */
function keyGlyphs(container: HTMLElement) {
  return [...container.querySelectorAll(".pi-key-bar-row button .pi-key-bar-glyph")]
    .map((glyph) => glyph.textContent ?? "")
    .slice(0, -1);
}

/** Every visible hint must be part of its button's accessible name (label in name). */
function expectHintsInNames(container: HTMLElement, expectedHints: number) {
  const hints = [...container.querySelectorAll<HTMLElement>(".pi-key-bar-row .pi-key-bar-hint")];
  expect(hints).toHaveLength(expectedHints);
  for (const hint of hints) {
    const name = hint.closest("button")?.getAttribute("aria-label") ?? "";
    expect(name.toLowerCase(), hint.textContent ?? "").toContain((hint.textContent ?? "").toLowerCase());
  }
}

async function clickKey(container: HTMLElement, ariaLabel: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${ariaLabel}"]`,
  );
  if (!button) {
    throw new Error(`Missing key: ${ariaLabel}`);
  }
  await act(async () => button.click());
}

function sentTerminalInput(socket: TestSocket): string[] {
  return socket.send.mock.calls
    .map(([data]) => JSON.parse(data as string) as { type: string; data?: string })
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data ?? "");
}

describe("TerminalView Pi Key Bar (Seam 3)", () => {
  it("switches its keys with Pi State records", async () => {
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();
    expect(sentTerminalInput(terminal)).toEqual([]);
    // `/` and `@` live in the Composer trigger row, never in the Key Bar.
    expect(keyLabels(container)).toEqual([
      "Shell command",
      "Cycle thinking level",
      "Toggle tool output",
      "Previous prompt",
      "Compose any key",
    ]);
    expectHintsInNames(container, 5);
    expect(keyGlyphs(container)).toEqual(["!", "⇥", "⌃O", "↑"]);

    await showState("busy");
    expect(keyLabels(container)).toEqual([
      "Stop the current run",
      "Steer the current run",
      "Queue a follow-up",
      "Toggle tool output",
      "Compose any key",
    ]);
    expectHintsInNames(container, 2);
    expect(keyGlyphs(container)).toEqual(["Stop", "Steer", "Queue", "⌃O"]);

    await showState("dialog");
    expect(keyLabels(container).slice(0, 5)).toEqual([
      "Previous choice",
      "Next choice",
      "Confirm choice (Enter)",
      "Cancel dialog (Esc)",
      "Toggle choice (Space)",
    ]);
    expectHintsInNames(container, 3);
    expect(keyGlyphs(container)).toEqual(["↑", "↓", "Enter", "Esc", "Space"]);
  });

  it("writes each key's exact terminal sequence", async () => {
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();

    await clickKey(container, "Cycle thinking level");
    await clickKey(container, "Shell command");
    await clickKey(container, "Toggle tool output");
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(terminal)).toEqual(["\x1b[Z", "!", "\x0f"]);

    await showState("busy");
    await clickKey(container, "Stop the current run");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(terminal).at(-1)).toBe("\x1b");

    await showState("dialog");
    await clickKey(container, "Confirm choice (Enter)");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(terminal).at(-1)).toBe("\r");
  });

  it("keeps the idle keys and the composer reachable when the bridge is offline", async () => {
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await showState("busy");
    await act(async () => {
      pi.close.mockClear();
      pi.dispatchEvent(new CloseEvent("close", { code: 4500, reason: "bridge_offline" }));
    });

    await openMobileKeys();
    expect(keyLabels(container).slice(0, 2)).toEqual(["Shell command", "Cycle thinking level"]);
    expect(container.querySelector('button[aria-label="Compose any key"]')).not.toBeNull();
  });

  it("opens the chord composer from the more-keys button and sends a chord", async () => {
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();

    // The chord toggle's visible hint is part of its name in both states.
    const toggleText = () =>
      container.querySelector<HTMLButtonElement>(".pi-key-bar-row button[aria-expanded]");
    expect(toggleText()?.textContent?.toLowerCase()).toContain("any key");
    expect(toggleText()?.getAttribute("aria-label")?.toLowerCase()).toContain("any key");

    await clickKey(container, "Compose any key");
    expect(container.querySelector('[aria-label="Pi key composer"]')).not.toBeNull();
    expect(toggleText()?.textContent?.toLowerCase()).toContain("close");
    expect(toggleText()?.getAttribute("aria-label")?.toLowerCase()).toContain("close");

    await clickKey(container, "Add Alt modifier");
    await clickKey(container, "Use Escape key");
    await act(async () => vi.advanceTimersByTime(40));
    await clickKey(container, "Send Alt + Esc");
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(terminal).at(-1)).toBe("\x1b\x1b");
    expect(container.querySelector('[aria-label="Pi key composer"]')).toBeNull();
  });

  it("keeps keyboard focus where it was when a key is pressed", async () => {
    const { container } = await renderTerminalView();
    await openSockets();
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Pi prompt"]');
    expect(field).not.toBeNull();
    field?.focus();
    expect(document.activeElement).toBe(field);

    // A pointer press on a Key Bar key must not move focus: a prevented
    // pointerdown stops the browser from focusing the button, and a mouse click
    // would otherwise take focus away from the terminal or Composer.
    const key = container.querySelector<HTMLButtonElement>('button[aria-label="Shell command"]');
    expect(key).not.toBeNull();
    await act(async () => {
      const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      const allowed = key?.dispatchEvent(press);
      expect(allowed).toBe(false);
    });

    expect(document.activeElement).toBe(field);
    expect(renderer.focusTextInput).not.toHaveBeenCalled();
  });

  it("never duplicates the Composer's `/` and `@` triggers in the Key Bar", async () => {
    const { container } = await renderTerminalView("pi", false);
    await openSockets();
    const labels = () => keyLabels(container);
    expect(labels()).not.toContain("Slash command");
    expect(labels()).not.toContain("File");

    await clickKey(container, "Open Composer");
    expect(container.querySelector('button[aria-label="Open slash suggestions"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open file suggestions"]')).not.toBeNull();
    expect(labels()).not.toContain("Slash command");

    await act(async () => vi.advanceTimersByTime(40));
    await clickKey(container, "Close Composer (Esc)");
    expect(labels()).not.toContain("Slash command");
    expect(labels()).toContain("Shell command");
  });

  it("renders no Key Bar on a non-Pi pane", async () => {
    const { container } = await renderTerminalView("claude");
    expect(container.querySelector(".pi-key-bar")).toBeNull();
  });
});