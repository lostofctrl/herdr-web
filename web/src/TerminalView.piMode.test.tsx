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
  autoFocus = false,
}: {
  paneId: string;
  pane: PaneInfo;
  mobile: boolean;
  autoFocus?: boolean;
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
        autoFocus={autoFocus}
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

  it("keeps the draft when a queued Enter is discarded before delivery", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { root, container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await typePrompt(promptField(container), "half delivered");

    await clickButton(container, "Send prompt");
    // Only the paste reached the socket; the Enter is still queued.
    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~half delivered\x1b[201~"]);
    // Tearing the terminal down drops the queued Enter instead of delivering it.
    await unmount(root);
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~half delivered\x1b[201~"]);
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("half delivered");

    // The retained draft is still available when the pane comes back.
    const remounted = await renderTerminalView({ paneId, pane, mobile: true });
    expect(promptField(remounted.container).value).toBe("half delivered");
  });

  it("ignores late composition edits that would restore a sent draft", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    const field = promptField(container);
    await typePrompt(field, "accepted prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    expect(field.value).toBe("");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "late correction");
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
    });

    expect(field.value).toBe("");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBeNull();
    expect(sentTerminalInput(socket)).toEqual([
      "\x1b[200~accepted prompt\x1b[201~",
      "\r",
    ]);

    // A composition that starts after the send is next-prompt input, not a late edit.
    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "fresh dictation");
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });

    expect(field.value).toBe("fresh dictation");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("fresh dictation");
  });

  it("strips paste markers so a draft cannot break out of its own bracketed paste", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    // Removing the inner marker would leave a marker behind without iteration.
    await typePrompt(promptField(container), "safe\x1b[20\x1b[201~1~rm -rf /");

    await clickButton(container, "Send prompt");

    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~saferm -rf /\x1b[201~"]);
  });

  it("keeps the mobile Key Bar and upload next to the Composer", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    expect(promptField(container)).toBeTruthy();
    expect(
      container.querySelector('button[aria-label="Upload file"]'),
    ).toBeTruthy();
    // The hosted Key Bar must not also render a command text row or Stage button.
    expect(container.querySelector('button[aria-label="Send command"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send enter"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Stage command in terminal"]'),
    ).toBeNull();
    expect(container.querySelectorAll("textarea, input.term-native-input").length).toBe(1);

    await act(async () => {
      const ctrlC = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button.term-key"),
      ).find((button) => button.textContent === "C-c");
      if (!ctrlC) {
        throw new Error("Missing C-c quick key");
      }
      ctrlC.click();
    });
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual(["\u0003"]);

    // The hosted chord composer still opens inside the Pi Composer.
    await clickButton(container, "Show more keys");
    expect(
      container.querySelector('[aria-label="Direct terminal keys"]'),
    ).toBeTruthy();
    await clickButton(container, "Compose terminal key");
    expect(container.textContent).toContain("Building shortcut");
  });

  it("does not send a whitespace-only draft on desktop Ctrl+Enter", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    const socket = await openSocket();

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
    await typePrompt(field, "   ");
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send prompt"]',
    );
    expect(send?.disabled).toBe(true);

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
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual([]);
    expect(field.value).toBe("   ");
  });

  it("ignores Ctrl+Space while another text field owns the keyboard", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    await openSocket();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();

    await act(async () => {
      outsideInput.dispatchEvent(
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

  it("ignores Ctrl+Space while an action menu is open", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    await openSocket();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);

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

  it("delivers a pending prompt once even when Send is repeated", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    const socket = await openSocket();
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
    await typePrompt(field, "only once");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clickButton(container, "Send prompt");
    }
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(socket)).toEqual([
      "\x1b[200~only once\x1b[201~",
      "\r",
    ]);
    expect(field.value).toBe("");
  });

  it("focuses the open Composer instead of the terminal on attach", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({
      paneId,
      pane,
      mobile: true,
      autoFocus: true,
    });
    const socket = openSocket();
    await socket;
    await act(async () => vi.advanceTimersByTime(1));

    expect(document.activeElement).toBe(promptField(container));
    expect(renderer.focus).not.toHaveBeenCalled();
  });
});
