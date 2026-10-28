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

  it("keeps the Pi Key Bar and image attach control next to the Composer", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    const socket = await openSocket();

    expect(promptField(container)).toBeTruthy();
    expect(container.querySelector('[aria-label="Pi keys"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Attach image"]')).toBeTruthy();
    // Pi mode must not also render a generic command row or Stage button.
    expect(container.querySelector('button[aria-label="Send command"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send enter"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Stage command in terminal"]'),
    ).toBeNull();
    expect(container.querySelectorAll("textarea, input.term-native-input").length).toBe(1);

    // A Key Bar key still reaches the terminal socket.
    await clickButton(container, "Command");
    await act(async () => vi.advanceTimersByTime(40));
    expect(sentTerminalInput(socket)).toEqual(["/"]);

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
  it("opens catalog commands and skills from /, filters as you type and never lists files", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    const pi = await openPiBridgeWithCatalog();
    const field = promptField(container);

    await typePrompt(field, "/");

    expect(suggestionPopup(container)).not.toBeNull();
    expect(suggestionLabels(container)).toEqual(["/compact", "/review", "tdd"]);
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

  it("opens the popup from the dedicated / and @ buttons without focusing the field", async () => {
    const { pane, paneId } = testPane(PANE_A);
    const { container } = await renderTerminalView({ paneId, pane, mobile: true });
    await openSocket();
    await openPiBridgeWithCatalog();
    const field = promptField(container);

    await clickButton(container, "Open slash suggestions");
    expect(field.value).toBe("/");
    expect(suggestionLabels(container)).toEqual(["/compact", "/review", "tdd"]);
    expect(document.activeElement).not.toBe(field);

    await typePrompt(field, "");
    await clickButton(container, "Open file suggestions");
    expect(field.value).toBe("@");
    expect(suggestionPopup(container)).not.toBeNull();
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

    expect(field.value).toBe("/review");
    expect(suggestionPopup(container)).toBeNull();
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
