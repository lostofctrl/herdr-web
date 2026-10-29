/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
import { TerminalView } from "./TerminalView";
import type { PaneInfo } from "./types";
import { readPiComposerDraft, writePiComposerDraft } from "./pi-mode/piComposerDraft";
import { insertPiComposerText } from "./pi/sidepanel/piComposerInsert";

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
  localStorage.clear();
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

async function renderTerminalView({ agent = "pi", mobile = true, bridgeId = BRIDGE_ID, selected = true } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (connectionKey = "test-connection", paneId = PANE_ID) => root.render(
      <CommandDraftContext.Provider value={createCommandDraftStore()}>
        <TerminalView
          bridgeId={bridgeId}
          pane={{ ...testPane(agent), pane_id: paneId, terminal_id: `${paneId}-terminal` }}
          connectionKey={connectionKey}
          resumeToken={0}
          httpUrl={(path) => path}
          wsUrl={(path, query) => (query ? `${path}?${query}` : path)}
          autoFocus={false}
          mobileControls={mobile}
          terminalOutputCoalesceMs={0}
          selected={selected}
        />
      </CommandDraftContext.Provider>,
    );
  await act(async () => render());
  return { container, root, reconnect: (paneId = PANE_ID) => act(async () => render("reconnected", paneId)) };
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
    models: [
      { provider: "anthropic", id: "claude", label: "Claude" },
      { provider: "openai", id: "gpt", label: "GPT" },
    ],
    thinking_levels: ["low", "medium", "high"],
    cwd: "/workspace",
  });
}

async function insertInAct(bridgeId: string, paneId: string, text: string) {
  await act(async () => insertPiComposerText(bridgeId, paneId, text));
}

function triggerPicker(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(".pi-model-picker-trigger");
  if (!trigger) throw new Error("Missing model picker trigger");
  return trigger;
}

function pickerRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-model-key]"));
}

async function typeSearch(container: HTMLElement, value: string) {
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
  if (!search) throw new Error("Missing model search field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function control<T extends HTMLElement>(container: HTMLElement, label: string): T {
  const element = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}

async function click(container: HTMLElement, label: string) {
  await act(async () => control<HTMLButtonElement>(container, label).click());
}

async function changeSelect(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    const select = control<HTMLSelectElement>(container, label);
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function piRequests(socket: TestSocket) {
  return socket.send.mock.calls.map(([data]) => JSON.parse(data as string) as Record<string, unknown>);
}

function sentTerminalInput(socket: TestSocket): string[] {
  return socket.send.mock.calls
    .map(([data]) => JSON.parse(data as string) as { type: string; data?: string })
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data ?? "");
}

describe("TerminalView Pi Side Panel (Seam 3)", () => {
  it("searches the full mobile catalog with metadata and inserts through the production Composer", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Unsent draft");
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();
    await sendPiRecord({ type: "hello", capabilities: { skills_catalog: true } });
    await showState("idle");
    await sendPiRecord({ type: "catalog", commands: [
      { name: "review", description: "Review extension", source: "extension" },
      { name: "template", description: "Prompt template", source: "prompt" },
    ], skills: [{ name: "tdd", description: "Red green workflow", source: "project" }], skills_note: "Supported catalog only" });
    await click(container, "Composer helpers");
    await click(container, "Browse commands and skills");
    expect(container.textContent).toContain("Prompt template");
    expect(container.textContent).toContain("command · extension");
    expect(container.textContent).toContain("Supported catalog only");
    const search = control<HTMLInputElement>(container, "Search commands and skills");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "PROJECT");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Insert /review"]')).toBeNull();
    await click(container, "Insert /skill:tdd");
    const field = control<HTMLTextAreaElement>(container, "Pi prompt");
    expect(field.value).toBe("Unsent draft\n/skill:tdd");
    expect(document.activeElement).toBe(field);
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Unsent draft\n/skill:tdd");
    expect(sentTerminalInput(terminal)).toEqual([]);
  });

  it("offers only supported mobile thinking levels, reports request failure and keeps the unsent draft", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Keep thinking draft");
    const { container } = await renderTerminalView();
    const { pi, terminal } = await openSockets();
    await showState("idle");
    await click(container, "Composer helpers");
    await click(container, "Choose Pi thinking level");
    expect(container.querySelector('[aria-label="Use thinking level max"]')).toBeNull();
    await click(container, "Use thinking level high");
    expect(container.textContent).toContain("Changing thinking level");
    expect(control<HTMLButtonElement>(container, "Use thinking level low").disabled).toBe(true);
    const request = piRequests(pi).at(-1)!;
    expect(request).toMatchObject({ type: "set_thinking_level", level: "high" });
    await sendPiRecord({ type: "response", id: request.id, ok: false, error: "Thinking unavailable" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Thinking unavailable");
    expect(control<HTMLButtonElement>(container, "Use thinking level medium").getAttribute("aria-pressed")).toBe("true");
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("Keep thinking draft");
    expect(sentTerminalInput(terminal)).toEqual([]);
    await click(container, "Use thinking level low");
    await sendPiRecord({ type: "response", id: piRequests(pi).at(-1)!.id, ok: true });
    expect(container.querySelector('[aria-label="Pi thinking levels"]')).toBeNull();
    expect(document.activeElement).toBe(control(container, "Composer helpers"));
  });

  it("exposes explicit mobile quick actions using exact PTY bytes without clearing an authored draft", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Keep quick action draft");
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();
    await showState("idle");
    for (const label of ["Abort Pi", "Compact Pi session", "New Pi session", "Resume Pi session"]) {
      await click(container, "Composer helpers");
      await click(container, label);
      await act(async () => vi.advanceTimersByTime(80));
      expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("Keep quick action draft");
    }
    expect(sentTerminalInput(terminal)).toEqual([
      "\x1b", "\x1b[200~/compact\x1b[201~", "\r",
      "\x1b[200~/new\x1b[201~", "\r", "\x1b[200~/resume\x1b[201~", "\r",
    ]);
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Keep quick action draft");
  });

  it("settles a dismissed quick action and blocks draft delivery/insertion until Enter-only recovery", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Keep recovery draft");
    const { container, reconnect } = await renderTerminalView();
    const { terminal } = await openSockets();
    await showState("idle");
    terminal.send.mockImplementation((data: string) => {
      if (JSON.parse(data).data === "\x1b[200~/compact\x1b[201~") terminal.readyState = 3;
    });
    await click(container, "Composer helpers");
    await click(container, "Compact Pi session");
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await reconnect();
    const reconnected = TestSocket.instances.filter((socket) => socket.url.startsWith("/ws/terminal")).at(-1)!;
    await act(async () => reconnected.dispatchEvent(new Event("open")));
    expect(control<HTMLButtonElement>(container, "Send prompt").disabled).toBe(true);
    await insertInAct(BRIDGE_ID, PANE_ID, "/review");
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("Keep recovery draft");
    terminal.readyState = 1;
    await click(container, "Composer helpers");
    expect(control<HTMLButtonElement>(container, "Browse commands and skills").disabled).toBe(true);
    await click(container, "Submit pending Pi action");
    await act(async () => vi.advanceTimersByTime(80));
    expect([...sentTerminalInput(terminal), ...sentTerminalInput(reconnected)]).toEqual(["\x1b[200~/compact\x1b[201~", "\r"]);
    expect(control<HTMLButtonElement>(container, "Send prompt").disabled).toBe(false);
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Keep recovery draft");
  });

  it("uses the shared searchable model picker as the only mobile subview and retains draft on failures", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Keep model draft");
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await showState("idle");
    await click(container, "Composer helpers");
    await click(container, "Choose Pi model");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelectorAll('[aria-label="Select Pi model"]')).toHaveLength(1);
    await typeSearch(container, "openai");
    expect(pickerRows(container)).toHaveLength(1);
    await act(async () => pickerRows(container)[0].click());
    const request = piRequests(pi).at(-1)!;
    expect(request).toMatchObject({ type: "set_model", provider: "openai", model: "gpt" });
    await sendPiRecord({ type: "response", id: request.id, ok: false, error: "Model unavailable" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Model unavailable");
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("Keep model draft");
    await act(async () => pickerRows(container)[0].click());
    await sendPiRecord({ type: "response", id: piRequests(pi).at(-1)!.id, ok: true });
    expect(container.querySelector('[aria-label="Select Pi model"]')).toBeNull();
    expect(document.activeElement).toBe(control(container, "Composer helpers"));
  });

  it.each(["connection", "pane"])("rejects old model responses and catalogs after the %s owner changes", async (owner) => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Owner draft");
    const { container, reconnect } = await renderTerminalView();
    const { pi: oldPi } = await openSockets();
    await showState("idle");
    await sendPiRecord({ type: "catalog", commands: [{ name: "old", description: "Old catalog", source: "extension" }], skills: [] });
    await click(container, "Composer helpers");
    await click(container, "Choose Pi model");
    await act(async () => pickerRows(container)[1].click());
    const oldRequest = piRequests(oldPi).at(-1)!;
    await reconnect(owner === "pane" ? "pane-b" : PANE_ID);
    expect(container.querySelector('[aria-label="Pi model controls"]')).toBeNull();
    const newPi = TestSocket.instances.filter((socket) => socket.url.startsWith("/ws/pi")).at(-1)!;
    const record = async (socket: TestSocket, value: Record<string, unknown>) => act(async () => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })));
    await act(async () => newPi.dispatchEvent(new Event("open")));
    const newTerminal = TestSocket.instances.filter((socket) => socket.url.startsWith("/ws/terminal")).at(-1)!;
    await act(async () => newTerminal.dispatchEvent(new Event("open")));
    await record(newPi, { type: "state", busy: "idle", model: null, models: [{ provider: "new", id: "new-model", label: "New model" }], thinking_level: "low", thinking_levels: ["low"], cwd: "/new" });
    await click(container, "Composer helpers");
    await click(container, "Choose Pi model");
    const focused = document.activeElement;
    await record(oldPi, { type: "response", id: oldRequest.id, ok: true });
    await record(oldPi, { type: "catalog", commands: [{ name: "late-old", description: "Late old catalog", source: "extension" }], skills: [] });
    expect(document.activeElement).toBe(focused);
    expect(pickerRows(container).map((row) => row.textContent)).toEqual(["New modelnew-model · new"]);
    await click(container, "Back to Composer helpers");
    expect(control<HTMLButtonElement>(container, "Browse commands and skills").disabled).toBe(true);
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe(owner === "pane" ? "" : "Owner draft");
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Owner draft");
  });

  it("dismisses bridge subviews on offline and ignores late thinking completion without stealing focus", async () => {
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await showState("idle");
    await click(container, "Composer helpers");
    await click(container, "Choose Pi thinking level");
    await click(container, "Use thinking level high");
    const request = piRequests(pi).at(-1)!;
    await act(async () => pi.dispatchEvent(new CloseEvent("close", { code: 4500, reason: "bridge_offline" })));
    expect(container.querySelector('[aria-label="Pi thinking levels"]')).toBeNull();
    await click(container, "Composer helpers");
    expect(control<HTMLButtonElement>(container, "Choose Pi model").disabled).toBe(true);
    expect(control<HTMLButtonElement>(container, "Abort Pi").disabled).toBe(false);
    const focus = document.activeElement;
    await sendPiRecord({ type: "response", id: request.id, ok: true });
    expect(document.activeElement).toBe(focus);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("gates mobile actions while detached, busy, dialog-blocked or offline without executing on open", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Busy draft");
    const { container } = await renderTerminalView();
    expect(control<HTMLButtonElement>(container, "Composer helpers").disabled).toBe(true);
    const { terminal, pi } = await openSockets();
    for (const busy of ["busy", "dialog"] as const) {
      await showState(busy);
      await click(container, "Composer helpers");
      for (const label of ["Choose Pi model", "Choose Pi thinking level", "Compact Pi session", "New Pi session", "Resume Pi session"]) {
        expect(control<HTMLButtonElement>(container, label).disabled, label).toBe(true);
      }
      expect(control<HTMLButtonElement>(container, "Abort Pi").disabled).toBe(false);
      expect(container.textContent).toContain("require an idle session");
      await click(container, "Composer helpers");
    }
    await act(async () => pi.dispatchEvent(new CloseEvent("close", { code: 4500, reason: "bridge_offline" })));
    await click(container, "Composer helpers");
    expect(control<HTMLButtonElement>(container, "Browse commands and skills").disabled).toBe(true);
    expect(control<HTMLButtonElement>(container, "Abort Pi").disabled).toBe(false);
    expect(sentTerminalInput(terminal)).toEqual([]);
    await click(container, "Abort Pi");
    expect(sentTerminalInput(terminal)).toEqual(["\x1b"]);
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Busy draft");
  });

  it("requests a model and thinking change but displays only the next Pi State", async () => {
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await showState("idle");
    await click(container, "Toggle Pi Side Panel");
    // Healthy bridge: no offline dot and no offline status.
    expect(container.querySelector(".pi-side-panel-dot")).toBeNull();
    expect(container.querySelector(".pi-side-panel-status")).toBeNull();
    const thinking = control<HTMLSelectElement>(container, "Pi thinking level");
    const publishedModel = () => container.querySelector(".pi-side-panel-model .pi-model-picker-trigger")?.textContent ?? "";
    expect(publishedModel()).toContain("claude");
    await act(async () => triggerPicker(container).click());
    await typeSearch(container, "gpt");
    expect(pickerRows(container).map((row) => row.dataset.modelKey)).toEqual([
      JSON.stringify(["openai", "gpt"]),
    ]);
    await act(async () => pickerRows(container)[0].click());
    const modelRequest = piRequests(pi).at(-1)!;
    expect(modelRequest).toMatchObject({ type: "set_model", provider: "openai", model: "gpt" });
    await sendPiRecord({ type: "response", id: modelRequest.id, ok: true });
    expect(publishedModel()).toContain("claude");

    await changeSelect(container, "Pi thinking level", "high");
    const thinkingRequest = piRequests(pi).at(-1)!;
    expect(thinkingRequest).toMatchObject({ type: "set_thinking_level", level: "high" });
    await sendPiRecord({ type: "response", id: thinkingRequest.id, ok: true });
    expect(thinking.value).toBe("medium");
    await sendPiRecord({ type: "state", busy: "idle", model: { provider: "openai", id: "gpt" },
      models: [{ provider: "openai", id: "gpt", label: "GPT" }],
      thinking_level: "high", thinking_levels: ["high"], cwd: "/workspace" });
    expect(publishedModel()).toContain("gpt");
    expect(thinking.value).toBe("high");
  });
  it("searches catalog metadata and inserts command/skill triggers into the live persistent Composer", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Keep this draft");
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();
    await sendPiRecord({ type: "hello", capabilities: { skills_catalog: true } });
    await sendPiRecord({ type: "catalog", commands: [
      { name: "review", description: "Review changes", source: "extension" },
      { name: "skill:catalogued", description: "Explicit skill command", source: "skill" },
    ], skills: [
      { name: "tdd", description: "Red green workflow", source: "project" },
    ] });
    await click(container, "Toggle Pi Side Panel");
    const search = control<HTMLInputElement>(container, "Search commands and skills");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "PROJECT");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Insert /review"]')).toBeNull();
    await click(container, "Insert /skill:tdd");
    const prompt = control<HTMLTextAreaElement>(container, "Pi prompt");
    expect(prompt.value).toBe("Keep this draft\n/skill:tdd");
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Keep this draft\n/skill:tdd");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container, "Insert /review");
    await click(container, "Insert /skill:catalogued");
    expect(prompt.value).toBe("Keep this draft\n/skill:tdd\n/review\n/skill:catalogued");
    expect(sentTerminalInput(terminal)).toEqual([]);
  });

  it("sends abort as Esc and session actions as separate Composer paste and Enter frames", async () => {
    writePiComposerDraft(BRIDGE_ID, PANE_ID, "Unsent prompt");
    const { container } = await renderTerminalView();
    const { terminal } = await openSockets();
    await click(container, "Toggle Pi Side Panel");
    for (const label of ["Abort Pi", "Compact Pi session", "New Pi session", "Resume Pi session"]) {
      await click(container, label);
      await act(async () => vi.advanceTimersByTime(80));
    }
    expect(sentTerminalInput(terminal)).toEqual([
      "\x1b", "\x1b[200~/compact\x1b[201~", "\r",
      "\x1b[200~/new\x1b[201~", "\r", "\x1b[200~/resume\x1b[201~", "\r",
    ]);
    expect(readPiComposerDraft(BRIDGE_ID, PANE_ID)).toBe("Unsent prompt");
  });

  it("keeps the actual model visible even when it is absent from the offered models", async () => {
    const { container } = await renderTerminalView();
    await openSockets();
    await sendPiRecord({ type: "state", busy: "idle", model: { provider: "custom", id: "current" },
      models: [{ provider: "other", id: "available", label: "Available" }],
      thinking_level: "medium", thinking_levels: [], cwd: "/workspace" });
    await click(container, "Toggle Pi Side Panel");
    const trigger = container.querySelector<HTMLElement>(".pi-side-panel-model .pi-model-picker-trigger");
    expect(trigger?.textContent).toContain("current");
    expect(control<HTMLSelectElement>(container, "Pi thinking level").value).toBe("medium");
    await act(async () => trigger?.click());
    const panelRows = pickerRows(container);
    expect(panelRows).toHaveLength(1);
    expect(container.textContent).toContain("current · custom (unavailable)");
    expect(panelRows[0].dataset.modelKey).toBe(JSON.stringify(["other", "available"]));
  });

  it("shows Bridge Offline and hides bridge-only controls while Composer and Key Bar stay usable", async () => {
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await sendPiRecord({ type: "hello", capabilities: { skills_catalog: true } });
    await showState("idle");
    await sendPiRecord({ type: "catalog", commands: [{ name: "review", description: "", source: "" }], skills: [] });
    await act(async () => {
      pi.dispatchEvent(new CloseEvent("close", { code: 4500, reason: "bridge_offline" }));
    });
    await click(container, "Toggle Pi Side Panel");
    const panel = control<HTMLElement>(container, "Pi Side Panel");
    expect(panel.textContent).toContain("Bridge Offline");
    // Collapsed or not, the offline state is exposed as a status, and the
    // decorative dot is hidden from assistive technology.
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("Bridge Offline");
    const dot = panel.querySelector(".pi-side-panel-dot");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    // The picker stays visible as published State but cannot change anything offline.
    expect(triggerPicker(container).disabled).toBe(true);
    expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
    for (const label of ["Pi thinking level", "Search commands and skills", "Insert /review"]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
    }
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").disabled).toBe(false);
    expect(container.querySelector(".pi-key-bar")).not.toBeNull();
    expect(container.querySelector('[aria-label="Abort Pi"]')).not.toBeNull();
  });

  it("reveals the Composer and inserts into its live value when closed on desktop", async () => {
    const { container } = await renderTerminalView({ mobile: false });
    await openSockets();
    expect(control<HTMLButtonElement>(container, "Toggle Pi Side Panel").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();
    await insertInAct("bridge-1", "pane-a", "/resume");
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("/resume");
    await click(container, "Toggle Pi Side Panel");
    expect(control<HTMLButtonElement>(container, "Toggle Pi Side Panel").getAttribute("aria-expanded")).toBe("true");
    await click(container, "Toggle Pi Side Panel");
    expect(container.querySelector('[aria-label="Search commands and skills"]')).toBeNull();
    expect(control<HTMLTextAreaElement>(container, "Pi prompt").value).toBe("/resume");
  });

  it("keeps commands usable and explains degraded skills when the catalog note is present", async () => {
    const { container } = await renderTerminalView();
    await openSockets();
    await sendPiRecord({ type: "hello", capabilities: { skills_catalog: false } });
    await sendPiRecord({ type: "catalog", commands: [{ name: "review", description: "Review", source: "extension" }],
      skills: [], skills_note: "Skills are unavailable in this Pi version." });
    await click(container, "Toggle Pi Side Panel");
    expect(control<HTMLElement>(container, "Commands and skills").textContent).toContain(
      "Skills are unavailable in this Pi version.",
    );
    expect(control<HTMLButtonElement>(container, "Insert /review")).not.toBeNull();
  });

});
