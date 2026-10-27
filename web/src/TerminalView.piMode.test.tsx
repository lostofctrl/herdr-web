/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
import { piComposerDraftKey } from "./pi-mode/piComposerDraft";
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
  send = vi.fn();
  close = vi.fn();
  constructor() {
    super();
    TestSocket.instances.push(this);
  }
}

const BRIDGE_ID = "bridge-1";
const PANE_A = "pane-a";
const PANE_B = "pane-b";
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.useFakeTimers();
  window.localStorage.clear();
  TestSocket.instances = [];
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function testPane(
  paneId: string,
  { agent = "pi", mobile = false }: { agent?: string; mobile?: boolean } = {},
) {
  return {
    paneId,
    pane: {
      pane_id: paneId,
      terminal_id: `${paneId}-terminal`,
      workspace_id: "workspace-1",
      tab_id: "tab-1",
      focused: true,
      agent,
      agent_status: "idle",
      revision: 1,
    } satisfies PaneInfo,
    mobile,
  };
}

async function renderTerminalView({
  paneId,
  pane,
  mobile,
}: {
  paneId: string;
  pane: PaneInfo;
  mobile: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const drafts = createCommandDraftStore();
  await act(async () => {
    root.render(
      <CommandDraftContext.Provider value={drafts}>
      <TerminalView
        bridgeId={BRIDGE_ID}
        pane={pane}
        connectionKey="test-connection"
        resumeToken={0}
        httpUrl={(path) => path}
        wsUrl={(path) => path}
        autoFocus={false}
        mobileControls={mobile}
        terminalOutputCoalesceMs={0}
        selected
      />
      </CommandDraftContext.Provider>,
    );
  });
  return { root, container, paneId };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
}

async function openSocket() {
  const socket = TestSocket.instances.at(-1);
  if (!socket) {
    throw new Error("Expected a terminal WebSocket");
  }
  await act(async () => socket.dispatchEvent(new Event("open")));
  return socket;
}

function promptField(container: HTMLElement) {
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Pi prompt"]');
  if (!field) {
    throw new Error("Missing Pi Composer field");
  }
  return field;
}

async function typePrompt(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(container: HTMLElement, ariaLabel: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${ariaLabel}"]`,
  );
  if (!button) {
    throw new Error(`Missing button: ${ariaLabel}`);
  }
  await act(async () => button.click());
  return button;
}

function sentTerminalInput(socket: TestSocket): string[] {
  return socket.send.mock.calls
    .map(([data]) => JSON.parse(data as string) as { type: string; data?: string })
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data ?? "");
}

describe("TerminalView Pi Composer (Seam 3)", () => {
  it("sends multi-line and special characters as one bracketed paste then Enter", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    const draft = "line 1\nline 2 😀 $HOME `cmd` \t\"quoted\"";
    await typePrompt(promptField(container), draft);

    await clickButton(container, "Send prompt");

    const paste = `\x1b[200~${draft}\x1b[201~`;
    expect(sentTerminalInput(socket)).toEqual([paste]);
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual([paste, "\r"]);
    expect(promptField(container).value).toBe("");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBeNull();
  });

  it("keeps the draft across pane switches and a reload", async () => {
    const first = testPane(PANE_A);
    const { root, container } = await renderTerminalView({
      paneId: first.paneId,
      pane: first.pane,
      mobile: true,
    });
    await openSocket();
    await typePrompt(promptField(container), "draft for pane A");
    await unmount(root);

    const second = testPane(PANE_B);
    const { root: secondRoot, container: secondContainer } = await renderTerminalView({
      paneId: second.paneId,
      pane: second.pane,
      mobile: true,
    });
    await openSocket();
    await typePrompt(promptField(secondContainer), "draft for pane B");
    await unmount(secondRoot);

    const reloaded = await renderTerminalView({
      paneId: first.paneId,
      pane: first.pane,
      mobile: true,
    });
    expect(promptField(reloaded.container).value).toBe("draft for pane A");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_B)),
    ).toBe("draft for pane B");
  });

  it("retains the draft when the terminal is not attached and the send cannot happen", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await typePrompt(promptField(container), "do not lose me");
    await act(async () => socket.dispatchEvent(new Event("close")));

    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send prompt"]',
    );
    expect(send?.disabled).toBe(true);
    expect(promptField(container).value).toBe("do not lose me");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("do not lose me");
  });

  it("opens on Ctrl+Space, sends on Ctrl+Enter and closes on Esc on desktop", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    const socket = await openSocket();

    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const field = promptField(container);
    expect(document.activeElement).toBe(field);

    await typePrompt(field, "desktop prompt");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~desktop prompt\x1b[201~"]);
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual([
      "\x1b[200~desktop prompt\x1b[201~",
      "\r",
    ]);

    await typePrompt(field, "unsent draft");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();
    expect(renderer.focusTextInput).toHaveBeenCalled();
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("unsent draft");
  });

  it("does not register the Composer on non-Pi panes", async () => {
    const { pane, paneId } = testPane(PANE_A, { agent: "claude" });
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();

    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();
    expect(container.querySelector('[aria-label="Open Composer"]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();
  });
});
