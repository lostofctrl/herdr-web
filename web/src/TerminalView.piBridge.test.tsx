/** @vitest-environment jsdom */
import { act, Fragment, StrictMode } from "react";
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
  setMouseCapture: vi.fn(),
  setTerminalKeyboardFlags: vi.fn(),
  onMouse: vi.fn(() => () => {}),
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

function testPane(paneId: string, agent: string): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: `${paneId}-terminal`,
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    focused: true,
    agent,
    agent_status: "idle",
    revision: 1,
  };
}

async function renderTerminalView(pane: PaneInfo, selected: boolean, mobile = false, strict = false) {
  const Wrapper = strict ? StrictMode : Fragment;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <Wrapper><CommandDraftContext.Provider value={createCommandDraftStore()}>
        <TerminalView
          bridgeId={BRIDGE_ID}
          pane={pane}
          connectionKey="test-connection"
          resumeToken={0}
          httpUrl={(path) => path}
          wsUrl={(path, query) => (query ? `${path}?${query}` : path)}
          autoFocus={false}
          mobileControls={mobile}
          terminalOutputCoalesceMs={0}
          selected={selected}
        />
      </CommandDraftContext.Provider></Wrapper>,
    );
  });
  if (mobile) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
  return { container, root };
}

function piSockets() {
  return TestSocket.instances.filter((socket) => socket.url.startsWith("/ws/pi"));
}

describe("TerminalView Pi bridge (Seam 3)", () => {
  it("opens one Pi bridge socket for the selected Pi Pane and requests a snapshot", async () => {
    await renderTerminalView(testPane(PANE_ID, "pi"), true);
    const sockets = piSockets();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(`/ws/pi?pane_id=${PANE_ID}`);

    await act(async () => sockets[0].dispatchEvent(new Event("open")));
    const sent = sockets[0].send.mock.calls.map(
      ([data]) => JSON.parse(data as string) as Record<string, unknown>,
    );
    expect(sent).toEqual([{ type: "get_snapshot", id: expect.any(String) }]);
  });

  it("mounts a Native Card for an ask_user_question dialog and removes it on dialog_closed", async () => {
    const { container } = await renderTerminalView(testPane(PANE_ID, "pi"), true);
    const pi = piSockets()[0];
    await act(async () => pi.dispatchEvent(new Event("open")));
    const snapshot = pi.send.mock.calls
      .map(([data]) => JSON.parse(data as string) as Record<string, unknown>)
      .find((record) => record.type === "get_snapshot");
    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "response",
            id: snapshot?.id,
            ok: true,
            result: {
              state: {
                busy: "dialog",
                model: null,
                thinking_level: "medium",
                models: [],
                thinking_levels: ["medium"],
                cwd: "/repo",
              },
              catalog: { commands: [], skills: [] },
              dialogs: [],
              assistant_message: null,
            },
          }),
        }),
      );
    });

    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "dialog_open",
            dialog: {
              id: "tool-1",
              kind: "question",
              timeout_ms: null,
              questions: [
                {
                  question: "Pick one",
                  header: "Choice",
                  multiSelect: false,
                  options: [{ label: "A", description: "First", preview: "" }],
                },
              ],
            },
          }),
        }),
      );
    });
    expect(container.querySelector("[data-pi-question-card]")).not.toBeNull();

    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "dialog_closed", id: "tool-1", resolution: "terminal" }),
        }),
      );
    });
    expect(container.querySelector("[data-pi-question-card]")).toBeNull();
  });

  it("sends the phone answer for a question card over the Pi socket", async () => {
    const { container } = await renderTerminalView(testPane(PANE_ID, "pi"), true);
    const pi = piSockets()[0];
    await act(async () => pi.dispatchEvent(new Event("open")));
    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "dialog_open",
            dialog: {
              id: "tool-1",
              kind: "question",
              timeout_ms: null,
              questions: [
                {
                  question: "Pick one",
                  header: "Choice",
                  multiSelect: false,
                  options: [{ label: "A", description: "First", preview: "" }],
                },
              ],
            },
          }),
        }),
      );
    });

    const option = [...container.querySelectorAll<HTMLButtonElement>(".pi-question-option")][0];
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const submit = container.querySelector<HTMLButtonElement>(".pi-question-submit");
    await act(async () => submit?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const records = pi.send.mock.calls.map(
      ([data]) => JSON.parse(data as string) as Record<string, unknown>,
    );
    const answer = records.find((record) => record.type === "dialog_answer");
    expect(answer).toMatchObject({ dialog_id: "tool-1" });
    expect(answer?.value).toEqual({ answers: [{ questionIndex: 0, optionIndexes: [0] }] });
  });

  it("renders a generic select card and answers it over the Pi socket", async () => {
    const { container } = await renderTerminalView(testPane(PANE_ID, "pi"), true);
    const pi = piSockets()[0];
    await act(async () => pi.dispatchEvent(new Event("open")));
    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "hello", protocol_version: 1, capabilities: { generic_dialogs: true } }),
        }),
      );
    });
    await act(async () => {
      pi.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "dialog_open",
            dialog: {
              id: "generic-1",
              kind: "select",
              title: "Choose a mode",
              message: "Pick one",
              options: [{ label: "Safe" }, { label: "Fast" }],
            },
          }),
        }),
      );
    });

    expect(container.querySelector("[data-pi-dialog-card]")).not.toBeNull();
    const fast = [...container.querySelectorAll<HTMLButtonElement>(".pi-dialog-card-option")].find(
      (button) => button.textContent?.includes("Fast"),
    );
    await act(async () => fast?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const records = pi.send.mock.calls.map(
      ([data]) => JSON.parse(data as string) as Record<string, unknown>,
    );
    const answer = records.find((record) => record.type === "dialog_answer");
    expect(answer).toMatchObject({ dialog_id: "generic-1", value: "Fast" });
  });

  it("opens no Pi bridge socket on a non-Pi pane", async () => {
    await renderTerminalView(testPane(PANE_ID, "claude"), true);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(piSockets()).toHaveLength(0);
  });

  it("opens no Pi bridge socket for an unselected Pi Pane", async () => {
    await renderTerminalView(testPane(PANE_ID, "pi"), false);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(piSockets()).toHaveLength(0);
  });
});


it("renders read-only first/current context inside the real mobile Composer under StrictMode, without HTML execution or losing offline input", async () => {
  const { container } = await renderTerminalView(testPane(PANE_ID, "pi"), true, true, true);
  const pi = piSockets().at(-1)!;
  const send = async (record: unknown) => act(async () => pi.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) })));
  await act(async () => pi.dispatchEvent(new Event("open")));
  await send({ type: "hello", protocol_version: 1, conversation_epoch: "live-epoch", capabilities: { conversation_snapshot: true } });
  await send({
    type: "conversation_update", schema_version: 1, epoch: "live-epoch", session_id: "live-session", leaf_id: "live-leaf", selection_generation: 1, revision: 1,
    availability: "ready", reason: null,
    exchanges: [
      { user: "first question", assistant: "<script>evil()</script>", status: "aborted", user_truncated: false, assistant_truncated: true },
      { user: "current unanswered", assistant: "", status: "running", user_truncated: false, assistant_truncated: false },
    ],
  });
  const region = container.querySelector('[role="region"][aria-label="Conversation context"]');
  expect(region).not.toBeNull();
  expect(region?.closest(".pi-composer")).not.toBeNull();
  expect(region?.textContent).toContain("first question");
  expect(region?.textContent).toContain("current unanswered");
  expect(region?.textContent).toContain("Aborted");
  expect(region?.textContent).toContain("Running");
  expect(region?.textContent).toContain("truncated");
  expect(region?.querySelector("script")).toBeNull();
  expect(region?.textContent).toContain("<script>evil()</script>");
  const contextSends = pi.send.mock.calls.map(([data]) => JSON.parse(data as string)).filter((r) => r.type === "get_conversation");
  expect(contextSends).toHaveLength(1);
  await act(async () => pi.dispatchEvent(Object.assign(new Event("close"), { code: 4500, reason: "bridge_offline" })));
  expect(container.querySelector('[aria-label="Conversation context"]')?.textContent).toContain("unavailable");
  expect(container.querySelector('[aria-label="Conversation context"]')?.textContent).not.toContain("first question");
  expect(container.querySelector('[aria-label="Pi prompt"]')).not.toBeNull();
});
