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
  await act(async () => {
    root.render(
      <CommandDraftContext.Provider value={createCommandDraftStore()}>
        <TerminalView
          bridgeId={bridgeId}
          pane={testPane(agent)}
          connectionKey="test-connection"
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
  });
  return { container, root };
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
  it("requests a model and thinking change but displays only the next Pi State", async () => {
    const { container } = await renderTerminalView();
    const { pi } = await openSockets();
    await showState("idle");
    await click(container, "Toggle Pi Side Panel");
    // Healthy bridge: no offline dot and no offline status.
    expect(container.querySelector(".pi-side-panel-dot")).toBeNull();
    expect(container.querySelector(".pi-side-panel-status")).toBeNull();
    const model = control<HTMLSelectElement>(container, "Pi model");
    const thinking = control<HTMLSelectElement>(container, "Pi thinking level");
    const gpt = [...model.options].find((option) => option.textContent?.includes("GPT"))!;
    await changeSelect(container, "Pi model", gpt.value);
    const modelRequest = piRequests(pi).at(-1)!;
    expect(modelRequest).toMatchObject({ type: "set_model", provider: "openai", model: "gpt" });
    await sendPiRecord({ type: "response", id: modelRequest.id, ok: true });
    expect(model.selectedOptions[0].textContent).toContain("Claude");

    await changeSelect(container, "Pi thinking level", "high");
    const thinkingRequest = piRequests(pi).at(-1)!;
    expect(thinkingRequest).toMatchObject({ type: "set_thinking_level", level: "high" });
    await sendPiRecord({ type: "response", id: thinkingRequest.id, ok: true });
    expect(thinking.value).toBe("medium");
    await sendPiRecord({ type: "state", busy: "idle", model: { provider: "openai", id: "gpt" },
      models: [{ provider: "openai", id: "gpt", label: "GPT" }],
      thinking_level: "high", thinking_levels: ["high"], cwd: "/workspace" });
    expect(model.selectedOptions[0].textContent).toContain("GPT");
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
    expect(control<HTMLSelectElement>(container, "Pi model").selectedOptions[0].textContent).toContain("current");
    expect(control<HTMLSelectElement>(container, "Pi thinking level").value).toBe("medium");
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
    for (const label of ["Pi model", "Pi thinking level", "Search commands and skills", "Insert /review"]) {
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
