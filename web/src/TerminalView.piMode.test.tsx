/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
import { insertPiComposerText } from "./pi/sidepanel/piComposerInsert";
import { piComposerDraftKey } from "./pi-mode/piComposerDraft";
import { clearPiComposerHistory, getPiComposerHistory } from "./pi-mode/piComposerHistory";
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
  constructor(url = "") {
    super();
    this.url = url;
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
  const renderTree = (connectionKey: string) => (
    <CommandDraftContext.Provider value={drafts}>
      <TerminalView
        bridgeId={BRIDGE_ID}
        pane={pane}
        connectionKey={connectionKey}
        resumeToken={0}
        httpUrl={(path, params) => (params ? `${path}?${params}` : path)}
        wsUrl={(path) => path}
        autoFocus={autoFocus}
        mobileControls={mobile}
        terminalOutputCoalesceMs={0}
        selected
      />
    </CommandDraftContext.Provider>
  );
  await act(async () => {
    root.render(renderTree("test-connection"));
  });
  if (mobile && pane.agent === "pi") await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
  // Reconnect by swapping the connection key, keeping this pane and Composer mounted.
  const reconnect = async () => {
    await act(async () => {
      root.render(renderTree(`test-connection-${TestSocket.instances.length}`));
    });
  };
  return { root, container, paneId, reconnect };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
}

function lastSocket(matches: (socket: TestSocket) => boolean) {
  for (let index = TestSocket.instances.length - 1; index >= 0; index -= 1) {
    const candidate = TestSocket.instances[index];
    if (matches(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function openSocket() {
  const socket = lastSocket((candidate) => !candidate.url.startsWith("/ws/pi"));
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
    field.focus();
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

  it("keeps the Key Bar reachable through the mobile menu and image attach beside the Composer", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    expect(promptField(container)).toBeTruthy();
    await clickButton(container, "Composer helpers");
    await clickButton(container, "Terminal keys and Reader");
    expect(container.querySelector('[aria-label="Pi keys"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Attach image"]')).toBeTruthy();
    // Pi mode must not also render a generic command row or Stage button.
    expect(container.querySelector('button[aria-label="Send command"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send enter"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Stage command in terminal"]'),
    ).toBeNull();
    expect(container.querySelectorAll("textarea, input.term-native-input").length).toBe(1);

    // Mobile helpers share one trigger; model and history remain available.
    const meta = container.querySelector(".pi-composer-meta");
    expect(meta?.querySelectorAll("button")).toHaveLength(3);
    expect(meta?.querySelector(".pi-model-picker-trigger")).not.toBeNull();
    expect(container.querySelector('.pi-composer-thumbrail button[aria-label="Composer helpers"]')).not.toBeNull();
    expect(meta?.querySelector('button[aria-label="Open file suggestions"]')).toBeNull();
    expect(meta?.querySelector('button[aria-label="Open prompt history"]')).not.toBeNull();
    // The Composer owns `/`, so the Key Bar no longer duplicates it there.
    expect(container.querySelector('button[aria-label="Slash command"]')).toBeNull();
    // A Key Bar key still reaches the terminal socket.
    await clickButton(container, "Shell command");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual(["!"]);

    // The Key Bar chord composer still opens for any chord.
    await clickButton(container, "Compose any key");
    expect(container.querySelector('[aria-label="Pi key composer"]')).toBeTruthy();
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

  it("submits a partially delivered prompt without pasting it again", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container, reconnect } = await renderTerminalView({
      paneId,
      pane,
      mobile: true,
    });
    const socket = await openSocket();
    await typePrompt(promptField(container), "submitted once");

    await clickButton(container, "Send prompt");
    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~submitted once\x1b[201~"]);
    // A terminal that cannot be retried drops the queued Enter after the paste landed.
    await act(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "closed", reason: "terminal attach taken over" }),
        }),
      );
      socket.dispatchEvent(new Event("close"));
    });
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~submitted once\x1b[201~"]);
    expect(promptField(container).value).toBe("submitted once");
    expect(
      container.querySelector(".pi-composer-recovery")?.textContent,
    ).toContain("reached Pi without Enter");

    // After reattaching, Send finishes the submission instead of pasting again.
    await reconnect();
    const nextSocket = await openSocket();
    await clickButton(container, "Submit prompt");
    await act(async () => vi.advanceTimersByTime(40));

    expect(sentTerminalInput(nextSocket)).toEqual(["\r"]);
    expect(promptField(container).value).toBe("");
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBeNull();
    expect(container.querySelector(".pi-composer-recovery")).toBeNull();
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

type UploadResponseStub = {
  name: string;
  path: string;
  size: number;
  mime: string | null;
};

/** Fake /api/uploads endpoint that the TerminalView upload flow already targets. */
function stubUploads() {
  const pending: Array<{
    name: string;
    body: unknown;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const name =
      (init?.body instanceof File ? init.body.name : null) ??
      new URL(url, "http://herdr.test").searchParams.get("name") ??
      "image.png";
    return new Promise((resolve, reject) => {
      pending.push({
        name,
        body: init?.body,
        resolve: () =>
          resolve({
            status: 200,
            ok: true,
            json: async () => ({ file: uploadStub(name) }),
          }),
        reject,
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pending };
}

function uploadStub(name: string): UploadResponseStub {
  return {
    name,
    path: `/tmp/uploads/${name}`,
    size: 3,
    mime: "image/png",
  };
}

function pngFile(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

async function dropFiles(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      types: ["Files"],
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
}

async function pasteFiles(target: Element, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      types: ["Files"],
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
}

function composerRoot(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>(".pi-composer");
  if (!root) {
    throw new Error("Missing Pi Composer root");
  }
  return root;
}

function attachmentChips(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-pi-attachment="chip"]'),
  );
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalView Pi Composer attachments (Seam 3)", () => {
  beforeEach(() => {
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:pi-attachment"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (URL as any).createObjectURL;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (URL as any).revokeObjectURL;
  });

  it("uploads an attached image before pasting its path ahead of the draft", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await dropFiles(composerRoot(container), [pngFile("shot.png")]);
    expect(attachmentChips(container)).toHaveLength(1);

    await typePrompt(promptField(container), "what is wrong?");
    await clickButton(container, "Send prompt");
    await flushAsync();

    // The upload must finish before anything reaches Pi's editor.
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("shot.png");
    expect(sentTerminalInput(socket)).toEqual([]);

    await act(async () => pending[0].resolve());
    await flushAsync();

    const paste = "\x1b[200~/tmp/uploads/shot.png what is wrong?\x1b[201~";
    expect(sentTerminalInput(socket)).toEqual([paste]);
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual([paste, "\r"]);
    expect(promptField(container).value).toBe("");
    expect(attachmentChips(container)).toHaveLength(0);
  });

  it("uploads in chip order and pastes the paths in that order", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await dropFiles(composerRoot(container), [pngFile("first.png"), pngFile("second.png")]);
    await typePrompt(promptField(container), "compare");
    await clickButton(container, "Send prompt");
    await flushAsync();

    // Sequential uploads: the second request starts only after the first resolves.
    expect(pending.map((entry) => entry.name)).toEqual(["first.png"]);
    await act(async () => pending[0].resolve());
    await flushAsync();
    expect(pending.map((entry) => entry.name)).toEqual(["first.png", "second.png"]);
    expect(sentTerminalInput(socket)).toEqual([]);

    await act(async () => pending[1].resolve());
    await flushAsync();

    expect(sentTerminalInput(socket)).toEqual([
      "\x1b[200~/tmp/uploads/first.png /tmp/uploads/second.png compare\x1b[201~",
    ]);
  });

  it("keeps the draft and chips with a visible error when an upload fails", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await dropFiles(composerRoot(container), [pngFile("broken.png")]);
    await typePrompt(promptField(container), "still here");
    await clickButton(container, "Send prompt");
    await flushAsync();

    await act(async () => pending[0].reject(new Error("Upload failed (500)")));
    await flushAsync();

    const error = container.querySelector('[role="alert"]');
    expect(error?.textContent).toContain("Upload failed (500)");
    expect(sentTerminalInput(socket)).toEqual([]);
    expect(promptField(container).value).toBe("still here");
    expect(attachmentChips(container)).toHaveLength(1);
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("still here");
  });

  it("removes an attachment chip before sending", async () => {
    const { fetchMock } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await pasteFiles(composerRoot(container), [pngFile("drop-me.png")]);
    expect(attachmentChips(container)).toHaveLength(1);

    await clickButton(container, "Remove attachment");
    expect(attachmentChips(container)).toHaveLength(0);

    await typePrompt(promptField(container), "no images");
    await clickButton(container, "Send prompt");
    await flushAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~no images\x1b[201~"]);
  });

  it("uploads an image dropped on the terminal of a Pi pane", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    const socket = await openSocket();

    await dropFiles(container.querySelector(".terminal-host") ?? container, [pngFile("desk.png")]);
    await flushAsync();

    expect(pending.map((entry) => entry.name)).toEqual(["desk.png"]);
    expect(attachmentChips(container)).toHaveLength(0);

    await act(async () => pending[0].resolve());
    await flushAsync();

    expect(sentTerminalInput(socket)).toEqual(["/tmp/uploads/desk.png"]);
  });

  it("leaves the existing non-Pi pane upload path untouched", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A, { agent: "claude" });
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await dropFiles(container.querySelector("section") ?? container, [pngFile("plain.png")]);
    await flushAsync();

    expect(pending.map((entry) => entry.name)).toEqual(["plain.png"]);
    expect(attachmentChips(container)).toHaveLength(0);

    await act(async () => pending[0].resolve());
    await flushAsync();

    expect(sentTerminalInput(socket)).toEqual(["/tmp/uploads/plain.png"]);
  });
});

const PI_SUGGEST_SNAPSHOT = {
  state: {
    busy: "idle",
    model: null,
    thinking_level: "off",
    models: [],
    thinking_levels: ["off"],
    cwd: "/repo",
  },
  catalog: {
    commands: [
      { name: "/compact", description: "Compact the session", source: "builtin" },
      { name: "/review", description: "Review the diff", source: "builtin" },
    ],
    skills: [{ name: "tdd", description: "Write tests first", source: "skill" }],
  },
  dialogs: [],
  assistant_message: null,
};

function piBridgeSocket() {
  const socket = lastSocket((candidate) => candidate.url.startsWith("/ws/pi"));
  if (!socket) {
    throw new Error("Missing Pi bridge WebSocket");
  }
  return socket;
}

function sentPiRecords(socket: TestSocket) {
  return socket.send.mock.calls.map(
    ([data]) => JSON.parse(data as string) as Record<string, unknown>,
  );
}

async function sendPiRecord(socket: TestSocket, record: Record<string, unknown>) {
  await act(async () => {
    socket.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(record) }),
    );
  });
}

async function openPiBridgeWithCatalog() {
  const socket = piBridgeSocket();
  await act(async () => socket.dispatchEvent(new Event("open")));
  const snapshot = sentPiRecords(socket).find((record) => record.type === "get_snapshot");
  if (!snapshot) {
    throw new Error("Missing get_snapshot request");
  }
  await sendPiRecord(socket, {
    type: "hello",
    protocol_version: 1,
    capabilities: { list_files: true, skills_catalog: true },
  });
  await sendPiRecord(socket, {
    type: "response",
    id: snapshot.id,
    ok: true,
    result: PI_SUGGEST_SNAPSHOT,
  });
  return socket;
}

function suggestionPopup(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-pi-suggestion-popup]");
}

function suggestionRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-pi-suggestion]"),
  );
}

function suggestionLabels(container: HTMLElement) {
  return suggestionRows(container).map((row) => row.dataset.suggestionLabel ?? "");
}

async function clickSuggestion(container: HTMLElement, label: string) {
  const row = suggestionRows(container).find(
    (candidate) => candidate.dataset.suggestionLabel === label,
  );
  if (!row) {
    throw new Error(`Missing suggestion: ${label}`);
  }
  await act(async () => row.click());
}

async function pressKey(field: HTMLTextAreaElement, key: string) {
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

async function selectRange(field: HTMLTextAreaElement, start: number, end = start) {
  await act(async () => {
    field.setSelectionRange(start, end);
    field.dispatchEvent(new Event("select", { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }),
    );
  });
}

describe("TerminalView Pi Composer suggestions (Seam 3)", () => {
  it("closes on blur, preserves pointer picks, and does not accept IME or modifier selection", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);
    await typePrompt(field, "/");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", altKey:true,bubbles:true,cancelable:true})));
    expect(field.value).toBe("/");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",isComposing:true,bubbles:true,cancelable:true})));
    expect(field.value).toBe("/");
    await pressKey(field, "Tab");
    expect(field.value).toBe("/compact ");
    expect(document.activeElement).toBe(field);
    await typePrompt(field, "/");
    await act(async () => field.blur());
    expect(suggestionPopup(container)).toBeNull();
    await act(async () => field.focus());
    expect(suggestionPopup(container)).not.toBeNull();
    await pressKey(field, "Escape");
    expect(suggestionPopup(container)).toBeNull();
    expect(promptField(container)).toBe(field);
  });

  it("keeps field focus for a pointer pick and prevents its mousedown default", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);
    await typePrompt(field, "/");

    const row = suggestionRows(container).find(
      (candidate) => candidate.dataset.suggestionLabel === "/compact",
    )!;
    // A real pointer press blurs the field unless the row prevents the default.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => row.dispatchEvent(mousedown));
    expect(mousedown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);

    await act(async () => row.click());
    expect(field.value).toBe("/compact ");
    expect(suggestionPopup(container)).toBeNull();
    expect(document.activeElement).toBe(field);
  });
  it("opens catalog commands and skills from /, filters as you type and never lists files", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();
    const field = promptField(container);

    await typePrompt(field, "/");

    expect(suggestionPopup(container)).not.toBeNull();
    expect(suggestionLabels(container)).toEqual(["/compact", "/review", "/skill:tdd"]);
    expect(container.textContent).toContain("Compact the session");
    expect(container.textContent).toContain("Write tests first");

    await typePrompt(field, "/co");

    expect(suggestionLabels(container)).toEqual(["/compact"]);
    await act(async () => vi.advanceTimersByTime(500));
    expect(sentPiRecords(pi).filter((record) => record.type === "list_files")).toEqual([]);
  });

  it("@ queries listFiles only after the debounce, with the 50-file limit, and caps rows at 20", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();
    const field = promptField(container);

    await typePrompt(field, "@src");
    expect(sentPiRecords(pi).filter((record) => record.type === "list_files")).toEqual([]);

    await act(async () => vi.advanceTimersByTime(199));
    expect(sentPiRecords(pi).filter((record) => record.type === "list_files")).toEqual([]);

    await act(async () => vi.advanceTimersByTime(1));
    const request = sentPiRecords(pi).find((record) => record.type === "list_files");
    expect(request).toMatchObject({ type: "list_files", query: "src", limit: 50 });
    if (!request) {
      throw new Error("Missing list_files request");
    }

    const files = Array.from({ length: 30 }, (_, index) => ({
      path: `src/file-${index}.ts`,
    }));
    await sendPiRecord(pi, {
      type: "response",
      id: request.id,
      ok: true,
      result: { files },
    });
    await flushAsync();

    expect(suggestionRows(container)).toHaveLength(20);
    expect(suggestionLabels(container)[0]).toBe("src/file-0.ts");
  });

  it("inserts the chosen suggestion at the cursor and keeps the rest of the draft", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();
    const field = promptField(container);

    await typePrompt(field, "hello @sr world");
    await selectRange(field, 9);
    await act(async () => vi.advanceTimersByTime(200));

    const request = sentPiRecords(pi).find((record) => record.type === "list_files");
    if (!request) {
      throw new Error("Missing list_files request");
    }
    await sendPiRecord(pi, {
      type: "response",
      id: request.id,
      ok: true,
      result: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    });
    await flushAsync();

    await clickSuggestion(container, "src/a.ts");

    expect(promptField(container).value).toBe("hello @src/a.ts world");
    expect(suggestionPopup(container)).toBeNull();
    expect(
      window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A)),
    ).toBe("hello @src/a.ts world");
  });

  it("hides suggestions when the Pi Bridge goes offline", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();

    await typePrompt(promptField(container), "/");
    expect(suggestionPopup(container)).not.toBeNull();

    await act(async () => {
      const event = new Event("close") as CloseEvent;
      Object.defineProperty(event, "code", { value: 4500 });
      Object.defineProperty(event, "reason", { value: "bridge_offline" });
      pi.dispatchEvent(event);
    });

    expect(suggestionPopup(container)).toBeNull();
  });

  it("opens production / and @ autocomplete from the helper menu and focuses the field", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);

    await clickButton(container, "Composer helpers");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="slash"]')?.click());
    expect(field.value).toBe("/");
    expect(suggestionLabels(container)).toEqual(["/compact", "/review", "/skill:tdd"]);
    expect(document.activeElement).toBe(field);

    await typePrompt(field, "");
    await clickButton(container, "Composer helpers");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="file"]')?.click());
    expect(field.value).toBe("@");
    expect(suggestionPopup(container)).not.toBeNull();
  });

  it("reopens an unchanged slash query after dismissing it through the helper menu", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);
    await typePrompt(field, "/");
    await clickButton(container, "Composer helpers");
    expect(suggestionPopup(container)).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="slash"]')?.click());
    expect(field.value).toBe("/");
    expect(field.selectionStart).toBe(1);
    expect(suggestionLabels(container)).toEqual(["/compact", "/review", "/skill:tdd"]);
    expect(sentTerminalInput(socket)).toEqual([]);
  });

  it("moves through suggestions with the keyboard and selects with Enter", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);

    await typePrompt(field, "/");
    await pressKey(field, "ArrowDown");
    await pressKey(field, "Enter");

    expect(field.value).toBe("/review ");
    expect(suggestionPopup(container)).toBeNull();
  });
});

describe("Pi Composer model picker (Seam 3)", () => {
  function modelRows(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-model-key]"));
  }
  function pickerTrigger(container: HTMLElement) {
    const trigger = container.querySelector<HTMLButtonElement>(".pi-composer .pi-model-picker-trigger");
    if (!trigger) throw new Error("Missing Composer model picker");
    return trigger;
  }
  async function openPickerWithModels() {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = piBridgeSocket();
    await act(async () => pi.dispatchEvent(new Event("open")));
    await sendPiRecord(pi, { type: "hello", protocol_version: 1, capabilities: {} });
    const idleState = (model: { provider: string; id: string }) => ({
      type: "state",
      busy: "idle",
      model,
      models: [
        { provider: "anthropic", id: "claude", label: "Claude Sonnet" },
        { provider: "openai", id: "gpt", label: "GPT Fast" },
      ],
      thinking_level: "medium",
      thinking_levels: ["medium"],
      cwd: "/workspace",
    });
    await sendPiRecord(pi, idleState({ provider: "anthropic", id: "claude" }));
    return { container, pi, idleState };
  }

  it("filters by label, requests the model and only displays the next Pi State", async () => {
    const { container, pi, idleState } = await openPickerWithModels();
    expect(pickerTrigger(container).textContent).toContain("claude");

    await act(async () => pickerTrigger(container).click());
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "open gpt");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modelRows(container).map((row) => row.dataset.modelKey)).toEqual([
      JSON.stringify(["openai", "gpt"]),
    ]);

    await act(async () => modelRows(container)[0].click());
    const request = sentPiRecords(pi).find((record) => record.type === "set_model");
    expect(request).toMatchObject({ type: "set_model", provider: "openai", model: "gpt" });
    await sendPiRecord(pi, { type: "response", id: request!.id, ok: true });
    expect(pickerTrigger(container).textContent).toContain("claude");

    await sendPiRecord(pi, idleState({ provider: "openai", id: "gpt" }));
    expect(pickerTrigger(container).textContent).toContain("gpt");
    expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
  });

  it("shows a failed change without changing the published model", async () => {
    const { container, pi } = await openPickerWithModels();
    await act(async () => pickerTrigger(container).click());
    await act(async () => modelRows(container)[1].click());
    const request = sentPiRecords(pi).find((record) => record.type === "set_model")!;
    await sendPiRecord(pi, { type: "response", id: request.id, ok: false, error: "model rejected" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("model rejected");
    expect(pickerTrigger(container).textContent).toContain("claude");
  });

  it("ignores a model change that settles after the panel was closed", async () => {
    const { container, pi, idleState } = await openPickerWithModels();
    await act(async () => pickerTrigger(container).click());
    await act(async () => modelRows(container)[1].click());
    const request = sentPiRecords(pi).find((record) => record.type === "set_model")!;

    // The user moves on before Pi answers: close the panel and go elsewhere.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();
    const field = promptField(container);
    await act(async () => field.focus());

    await sendPiRecord(pi, { type: "response", id: request.id, ok: true });
    // A late answer must not steal focus back to the trigger or reopen anything.
    expect(document.activeElement).toBe(field);
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();

    await sendPiRecord(pi, idleState({ provider: "openai", id: "gpt" }));
    expect(pickerTrigger(container).textContent).toContain("gpt");
  });

  it("drops a pending change and its panel when the pane disconnects", async () => {
    const { container, pi } = await openPickerWithModels();
    await act(async () => pickerTrigger(container).click());
    await act(async () => modelRows(container)[1].click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Changing model…");

    await act(async () => {
      const event = new Event("close") as CloseEvent;
      Object.defineProperty(event, "code", { value: 4501 });
      Object.defineProperty(event, "reason", { value: "unknown_pane" });
      pi.dispatchEvent(event);
    });

    // The rejected request must not surface as an error against the new identity.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();
    expect(pickerTrigger(container).textContent).toContain("claude");
  });
});

describe("Pi Composer prompt recall (Seam 3)", () => {
  it("recalls sent prompts oldest-last, restores the live draft and stays per pane", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await piBridgeSocket().dispatchEvent(new Event("open"));
    const field = promptField(container);
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));

    await typePrompt(field, "first prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    expect(field.value).toBe("");
    await typePrompt(field, "second prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    expect(field.value).toBe("");
    await typePrompt(field, "live draft");
    await selectRange(field, 0);

    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("second prompt");
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("first prompt");
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("first prompt");
    await pressKey(field, "ArrowDown");
    expect(field.value).toBe("second prompt");
    await pressKey(field, "ArrowDown");
    expect(field.value).toBe("live draft");
    await pressKey(field, "ArrowDown");
    expect(field.value).toBe("live draft");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBe("live draft");
  });

  it("keeps edits made to a recalled prompt instead of restoring the old draft", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await piBridgeSocket().dispatchEvent(new Event("open"));
    const field = promptField(container);
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));

    await typePrompt(field, "line one\nline two");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    await typePrompt(field, "live draft");
    await selectRange(field, 0);

    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("line one\nline two");
    await typePrompt(field, "line one\nline two edited");
    // Editing ends browsing, so the recalled text cannot be swapped back in.
    await pressKey(field, "ArrowDown");
    expect(field.value).toBe("line one\nline two edited");
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("line one\nline two edited");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBe(
      "line one\nline two edited",
    );
  });

  it("ends browsing when a trigger or completion changes the recalled text", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));
    const field = promptField(container);
    await typePrompt(field, "remembered");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    await typePrompt(field, "live draft");
    const sentBefore = sentTerminalInput(socket).length;
    await selectRange(field, 0);

    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("remembered");
    // A trigger button is an authored edit even though the field onChange never ran.
    await clickButton(container, "Composer helpers");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="slash"]')?.click());
    expect(field.value).toBe("/remembered");
    await pressKey(field, "ArrowDown");
    expect(field.value).toBe("/remembered");
    expect(sentTerminalInput(socket)).toHaveLength(sentBefore);
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBe("/remembered");
  });
});

describe("Pi controls stack height (Seam 3)", () => {
  it("keeps the desktop Key Bar and Composer stack height contract", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function boundingRect(this: HTMLElement) {
      const height = this.classList.contains("pi-key-bar")
        ? 51
        : this.classList.contains("pi-composer")
          ? 105
          : 0;
      return {
        x: 0,
        y: 0,
        width: 0,
        height,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      const { pane, paneId } = testPane(PANE_A);
      const { container } = await renderTerminalView({ paneId, pane, mobile: false });
      await openSocket();
      const stage = container.querySelector<HTMLElement>(".terminal-stage");
      expect(container.querySelector(".pi-key-bar")).not.toBeNull();
      expect(container.querySelector(".pi-composer")).not.toBeNull();
      await act(async () => {});
      expect(stage?.style.getPropertyValue("--terminal-command-controls-height")).toBe("156px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe("Pi Composer prompt history panel (Seam 3)", () => {
  function historyPanel(container: HTMLElement) {
    return container.querySelector<HTMLElement>('[aria-label="Prompt history"]');
  }
  function historyEntries(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-pi-history-entry]"));
  }
  async function openHistory(container: HTMLElement) {
    await clickButton(container, "Open prompt history");
  }

  it("does not write a recalled prompt to the persisted draft", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await piBridgeSocket().dispatchEvent(new Event("open"));
    const field = promptField(container);
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));

    await typePrompt(field, "secret-ish prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBeNull();

    // Browsing history shows the old prompt, but does not persist it again.
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("secret-ish prompt");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBeNull();
    await openHistory(container);
    await act(async () => historyEntries(container)[0].click());    expect(field.value).toBe("secret-ish prompt");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBeNull();

    // Authoring the text persists it again.
    await typePrompt(field, "secret-ish prompt edited");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBe(
      "secret-ish prompt edited",
    );
  });

  it("clears the delivered draft when a recall replaced it mid-send", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await piBridgeSocket().dispatchEvent(new Event("open"));
    const field = promptField(container);
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));

    await typePrompt(field, "older prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));

    // The second send is still in flight, so recall happens before it settles.
    await typePrompt(field, "in flight");
    await clickButton(container, "Send prompt");
    await selectRange(field, 0);
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("older prompt");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBe("in flight");

    await act(async () => vi.advanceTimersByTime(40));
    // The recalled text stays, but the delivered prompt cannot return on reload.
    expect(field.value).toBe("older prompt");
    expect(window.localStorage.getItem(piComposerDraftKey(BRIDGE_ID, PANE_A))).toBeNull();
    expect(getPiComposerHistory(BRIDGE_ID, PANE_A)).toEqual(["in flight", "older prompt"]);
  });

  it("appends a side-panel command to the prompt the Composer is showing", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));
    const field = promptField(container);
    await typePrompt(field, "remembered prompt");
    await clickButton(container, "Send prompt");
    await act(async () => vi.advanceTimersByTime(40));
    const sentBefore = sentTerminalInput(socket).length;

    await openHistory(container);
    await act(async () => historyEntries(container)[0].click());
    expect(field.value).toBe("remembered prompt");
    await typePrompt(field, "");
    await pressKey(field, "ArrowUp");
    expect(field.value).toBe("remembered prompt");

    // The side panel appends to the live draft, not to the stale stored one.
    await act(async () => insertPiComposerText(BRIDGE_ID, PANE_A, "/skill:tdd"));
    expect(field.value).toBe("remembered prompt\n/skill:tdd");
    expect(sentTerminalInput(socket)).toHaveLength(sentBefore);
  });

  it("searches newest-first, replaces the draft without sending and clears", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));
    const field = promptField(container);
    for (const prompt of ["first prompt", "second prompt"]) {
      await typePrompt(field, prompt);
      await clickButton(container, "Send prompt");
      await act(async () => vi.advanceTimersByTime(40));
    }
    await typePrompt(field, "live draft");
    const sentBefore = sentTerminalInput(socket).length;

    await openHistory(container);
    expect(historyPanel(container)).not.toBeNull();
    expect(historyEntries(container).map((row) => row.textContent)).toEqual([
      "second prompt",
      "first prompt",
    ]);
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search prompt history"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "FIRST");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(historyEntries(container)).toHaveLength(1);

    await act(async () => historyEntries(container)[0].click());
    expect(field.value).toBe("first prompt");
    expect(field.selectionStart).toBe("first prompt".length);
    expect(sentTerminalInput(socket).length).toBe(sentBefore);
    expect(historyPanel(container)).toBeNull();

    await openHistory(container);
    await clickButton(container, "Clear history");
    expect(container.textContent).toContain("No prompts yet");
    expect(historyEntries(container)).toHaveLength(0);
    await clickButton(container, "Close prompt history");
    expect(historyPanel(container)).toBeNull();
    expect(field.value).toBe("first prompt");
  });

  it("records a partially delivered prompt once, after the recovery send", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container, reconnect } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();
    await act(async () => clearPiComposerHistory(BRIDGE_ID, PANE_A));
    const field = promptField(container);

    await typePrompt(field, "recover me");
    await clickButton(container, "Send prompt");
    // Only the paste reached Pi; the queued Enter is dropped with the attach.
    expect(sentTerminalInput(socket)).toEqual(["\x1b[200~recover me\x1b[201~"]);
    await act(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "closed", reason: "terminal attach taken over" }),
        }),
      );
      socket.dispatchEvent(new Event("close"));
    });
    await act(async () => vi.advanceTimersByTime(40));
    expect(container.querySelector(".pi-composer-recovery")).not.toBeNull();
    // The paste alone is not a delivered prompt, so nothing is remembered yet.
    expect(getPiComposerHistory(BRIDGE_ID, PANE_A)).toEqual([]);

    await reconnect();
    const nextSocket = await openSocket();
    await clickButton(container, "Submit prompt");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(nextSocket)).toEqual(["\r"]);

    expect(getPiComposerHistory(BRIDGE_ID, PANE_A)).toEqual(["recover me"]);
    await openHistory(container);
    expect(historyEntries(container).map((row) => row.textContent)).toEqual(["recover me"]);
  });

  it("keeps only one popup open at a time", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();
    await sendPiRecord(pi, {
      type: "state",
      busy: "idle",
      model: { provider: "anthropic", id: "claude" },
      models: [{ provider: "anthropic", id: "claude", label: "Claude" }],
      thinking_level: "medium",
      thinking_levels: ["medium"],
      cwd: "/workspace",
    });
    const field = promptField(container);

    await typePrompt(field, "/");
    expect(suggestionPopup(container)).not.toBeNull();
    await openHistory(container);
    expect(suggestionPopup(container)).toBeNull();
    await clickButton(container, "Close prompt history");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".pi-model-picker-trigger")?.click();
    });
    expect(container.querySelector('[aria-label="Select Pi model"]')).not.toBeNull();
    await openHistory(container);
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();
    expect(suggestionPopup(container)).toBeNull();
  });

  it("keeps focus on a model row while the panel position updates", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    await openSocket();
    await act(async () => piBridgeSocket().dispatchEvent(new Event("open")));
    await sendPiRecord(piBridgeSocket(), { type: "hello", protocol_version: 1, capabilities: {} });
    await sendPiRecord(piBridgeSocket(), {
      type: "state",
      busy: "idle",
      model: { provider: "anthropic", id: "claude" },
      models: [
        { provider: "anthropic", id: "claude", label: "Claude" },
        { provider: "openai", id: "gpt", label: "GPT" },
      ],
      thinking_level: "medium",
      thinking_levels: ["medium"],
      cwd: "/workspace",
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".pi-model-picker-trigger")?.click();
    });
    const panel = container.querySelector<HTMLElement>('[aria-label="Select Pi model"]')!;
    const search = panel.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
    expect(document.activeElement).toBe(search);
    const row = panel.querySelector<HTMLButtonElement>('[role="option"] button')!;
    row.focus();
    // Scrolling and resizing reposition the panel, which must not yank focus
    // back to the search field while the user is tabbing through models.
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(document.activeElement).toBe(row);
  });

  it("reopens the desktop Composer without the model panel it was closed with", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: false });
    await openSocket();
    const pi = piBridgeSocket();
    await act(async () => pi.dispatchEvent(new Event("open")));
    await sendPiRecord(pi, { type: "hello", protocol_version: 1, capabilities: {} });
    await sendPiRecord(pi, {
      type: "state",
      busy: "idle",
      model: { provider: "anthropic", id: "claude" },
      models: [{ provider: "anthropic", id: "claude", label: "Claude" }],
      thinking_level: "medium",
      thinking_levels: ["medium"],
      cwd: "/workspace",
    });
    const openComposer = async () => {
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true, cancelable: true }),
        );
      });
    };

    await openComposer();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".pi-model-picker-trigger")?.click();
    });
    expect(container.querySelector('[aria-label="Select Pi model"]')).not.toBeNull();

    await act(async () => {
      promptField(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();

    await openComposer();
    expect(container.querySelector('[aria-label="Pi prompt"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();
  });
});

class TestImage {
  static instances: TestImage[] = [];
  naturalWidth = 40;
  naturalHeight = 30;
  width = 40;
  height = 30;
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    TestImage.instances.push(this);
  }
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function fakeCanvasContext() {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "measureText" ? () => ({ width: 10 }) : () => {},
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

async function clickTextButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`Missing button with text: ${text}`);
  }
  await act(async () => button.click());
}

function screenshotEditorDialog(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Screenshot Editor"]',
  );
}

describe("TerminalView Pi Composer Screenshot Editor (Seam 3)", () => {
  beforeEach(() => {
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => `blob:pi-attachment-${blob.type}`),
      revokeObjectURL: vi.fn(),
    });
    TestImage.instances = [];
    vi.stubGlobal("Image", TestImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeCanvasContext(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,AQID",
    );
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (URL as any).createObjectURL;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (URL as any).revokeObjectURL;
    vi.restoreAllMocks();
  });

  it("opens the editor from a chip and uploads the edited PNG on save", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    await dropFiles(composerRoot(container), [pngFile("shot.jpg")]);
    expect(attachmentChips(container)).toHaveLength(1);

    await clickButton(container, "Edit shot.jpg");
    await flushAsync();
    expect(screenshotEditorDialog(container)).not.toBeNull();

    await clickTextButton(container, "Save");
    await flushAsync();
    expect(screenshotEditorDialog(container)).toBeNull();

    const chip = attachmentChips(container)[0];
    expect(chip.querySelector(".pi-attachment-name")?.textContent).toBe("shot.png");

    await typePrompt(promptField(container), "after edit");
    await clickButton(container, "Send prompt");
    await flushAsync();

    expect(pending).toHaveLength(1);
    const body = pending[0].body as File;
    expect(pending[0].name).toBe("shot.png");
    expect(body.type).toBe("image/png");
    expect(body.size).toBe(3);

    await act(async () => pending[0].resolve());
    await flushAsync();
    expect(
      socket.send.mock.calls.some(
        (call: unknown[]) =>
          JSON.parse(call[0] as string).data ===
          "\x1b[200~/tmp/uploads/shot.png after edit\x1b[201~",
      ),
    ).toBe(true);
  });

  it("keeps the original chip image when the editor is cancelled", async () => {
    const { pending } = stubUploads();
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();

    await dropFiles(composerRoot(container), [pngFile("keep.jpg")]);
    await clickButton(container, "Edit keep.jpg");
    await flushAsync();
    expect(screenshotEditorDialog(container)).not.toBeNull();

    await clickTextButton(container, "Cancel");
    await flushAsync();
    expect(screenshotEditorDialog(container)).toBeNull();
    expect(
      attachmentChips(container)[0].querySelector(".pi-attachment-name")?.textContent,
    ).toBe("keep.jpg");

    await typePrompt(promptField(container), "unchanged");
    await clickButton(container, "Send prompt");
    await flushAsync();
    expect(pending).toHaveLength(1);
    expect((pending[0].body as File).type).toBe("image/png");

    await act(async () => pending[0].resolve());
    await flushAsync();
  });
});

describe("TerminalView Reader Sheet (Seam 3)", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function piSocket() {
    const current = TestSocket.instances.find((socket) => "url" in socket && String(socket.url).startsWith("/ws/pi"));
    if (!current) {
      throw new Error("Expected a Pi bridge WebSocket");
    }
    return current;
  }

  async function sendPi(current: TestSocket, record: Record<string, unknown>) {
    await act(async () => {
      current.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) }));
    });
  }

  async function openPi(current: TestSocket) {
    await act(async () => current.dispatchEvent(new Event("open")));
    // The Reader Sheet is a capability-gated surface, so the bridge announces it.
    await sendPi(current, {
      type: "hello",
      protocol_version: 1,
      capabilities: { assistant_message: true, generic_dialogs: true },
    });
  }

  function snapshotId(current: TestSocket) {
    const frame = current.send.mock.calls
      .map(([data]) => JSON.parse(data as string) as Record<string, unknown>)
      .find((record) => record.type === "get_snapshot");
    if (!frame) {
      throw new Error("Expected a get_snapshot frame");
    }
    return frame.id as string;
  }

  async function closePi(current: TestSocket, code: number) {
    await act(async () => {
      const event = new Event("close") as CloseEvent;
      Object.defineProperty(event, "code", { value: code });
      Object.defineProperty(event, "reason", { value: "" });
      current.dispatchEvent(event);
    });
  }

  async function snapshotWith(message: string | null) {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const pi = piSocket();
    await openPi(pi);
    await sendPi(pi, {
      type: "response",
      id: snapshotId(pi),
      ok: true,
      result: {
        state: {
          busy: "idle",
          model: null,
          thinking_level: "off",
          models: [],
          thinking_levels: ["off"],
          cwd: "/repo",
        },
        catalog: { commands: [], skills: [] },
        dialogs: [],
        assistant_message: message,
      },
    });
    await openSocket();
    await clickButton(container, "Composer helpers");
    await clickButton(container, "Terminal keys and Reader");
    return { container, pi };
  }

  it("shows the snapshot message as formatted Markdown and updates on a new message", async () => {
    const { container } = await snapshotWith(
      "# First answer\n\nRead **this** carefully.\n\n```ts\nconst answer = 42;\n```",
    );

    await clickButton(container, "Open Reader Sheet");
    expect(container.querySelector(".reader-markdown h1")?.textContent).toBe("First answer");
    expect(container.querySelector(".reader-markdown strong")?.textContent).toBe("this");
    expect(container.querySelector(".reader-markdown pre code")?.textContent).toContain(
      "const answer = 42;",
    );

    const pi = piSocket();
    await sendPi(pi, { type: "assistant_message", text: "## Updated answer\n\nNew body." });

    expect(container.querySelector(".reader-markdown h2")?.textContent).toBe("Updated answer");
    expect(container.querySelector(".reader-markdown p")?.textContent).toBe("New body.");
    expect(container.querySelector(".reader-markdown h1")).toBeNull();
  });

  it("copies one code block from the sheet", async () => {
    const { container } = await snapshotWith(
      "Use this:\n\n```sh\nnpm --prefix web test\n```\n",
    );

    await clickButton(container, "Open Reader Sheet");
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code block"]',
    );
    expect(copy).not.toBeNull();
    await act(async () => copy?.click());

    expect(writeText).toHaveBeenCalledWith("npm --prefix web test");
  });

  it("hides the Reader Sheet when the Pi Bridge goes offline", async () => {
    const { container } = await snapshotWith("Latest answer");
    expect(container.querySelector('[aria-label="Open Reader Sheet"]')).not.toBeNull();

    await clickButton(container, "Open Reader Sheet");
    expect(container.querySelector(".reader-sheet")).not.toBeNull();

    await closePi(piSocket(), 4500);

    expect(container.querySelector(".reader-sheet")).toBeNull();
    expect(container.querySelector('[aria-label="Open Reader Sheet"]')).toBeNull();
  });

  it("does not offer the Reader Sheet on a non-Pi pane", async () => {
    const { pane, paneId } = testPane(PANE_A, { agent: "claude" });
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    expect(container.querySelector('[aria-label="Open Reader Sheet"]')).toBeNull();
  });
});
