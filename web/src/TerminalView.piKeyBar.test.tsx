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

async function renderTerminalView(agent = "pi") {
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
          mobileControls
          terminalOutputCoalesceMs={0}
          selected
        />
      </CommandDraftContext.Provider>,
    );
  });
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
  return { terminal, pi };
}

async function sendPiRecord(record: Record<string, unknown>) {
  await act(async () => {
    piSocket().dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(record) }),
    );
  });
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
}

/** Key Bar keys in order, named by their accessible label. */
function keyLabels(container: HTMLElement) {
  return [...container.querySelectorAll(".pi-key-bar-row button")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
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
    expect(keyLabels(container)).toEqual([
      "Command",
      "File",
      "Shell command",
      "Cycle thinking level",
      "Toggle tool output",
      "Previous prompt",
      "Compose any key",
    ]);

    await showState("busy");
    expect(keyLabels(container)).toEqual([
      "Abort the current run",
      "Steer the current run",
      "Queue a follow-up",
      "Toggle tool output",
      "Compose any key",
    ]);

    await showState("dialog");
    expect(keyLabels(container).slice(0, 5)).toEqual([
      "Previous choice",
      "Next choice",
      "Confirm choice",
      "Cancel dialog",
      "Toggle choice",
    ]);
  });

  it("writes each key's exact terminal sequence", async () => {
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();

    await clickKey(container, "Cycle thinking level");
    await clickKey(container, "Previous prompt");
    await clickKey(container, "Command");
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(terminal)).toEqual(["\x1b[Z", "\x1b[A", "/"]);

    await showState("busy");
    await clickKey(container, "Abort the current run");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(terminal).at(-1)).toBe("\x1b");

    await showState("dialog");
    await clickKey(container, "Confirm choice");
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

    expect(keyLabels(container).slice(0, 3)).toEqual(["Command", "File", "Shell command"]);
    expect(container.querySelector('button[aria-label="Compose any key"]')).not.toBeNull();
  });

  it("opens the chord composer from the more-keys button and sends a chord", async () => {
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();

    await clickKey(container, "Compose any key");
    expect(container.querySelector('[aria-label="Pi key composer"]')).not.toBeNull();

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
    const key = container.querySelector<HTMLButtonElement>('button[aria-label="Command"]');
    expect(key).not.toBeNull();
    await act(async () => {
      const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      const allowed = key?.dispatchEvent(press);
      expect(allowed).toBe(false);
    });

    expect(document.activeElement).toBe(field);
    expect(renderer.focusTextInput).not.toHaveBeenCalled();
  });

  it("renders no Key Bar on a non-Pi pane", async () => {
    const { container } = await renderTerminalView("claude");
    expect(container.querySelector(".pi-key-bar")).toBeNull();
  });
});