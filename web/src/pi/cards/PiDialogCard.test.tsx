/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiBridgeProvider } from "../PiBridgeContext";
import { PiDialogCards } from "./PiDialogCard";

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

const PANE_ID = "pane-a";
const roots: Root[] = [];

const SNAPSHOT = {
  state: {
    busy: "idle",
    model: null,
    thinking_level: "medium",
    models: [],
    thinking_levels: ["medium"],
    cwd: "/repo",
  },
  catalog: { commands: [], skills: [] },
  dialogs: [],
  assistant_message: null,
};

const QUESTION = {
  id: "tool-1",
  kind: "question" as const,
  timeout_ms: null,
  questions: [
    {
      question: "Which layout should the card use?",
      header: "Layout",
      multiSelect: false,
      options: [{ label: "Stack", description: "One column", preview: "" }],
    },
  ],
};

const SELECT = {
  id: "generic-1",
  kind: "select" as const,
  title: "Choose a mode",
  message: "Pick one",
  options: [{ label: "Safe", description: "Read only" }, { label: "Fast" }],
  timeout_ms: 3000,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", TestSocket);
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

function socket() {
  const current = TestSocket.instances.at(-1);
  if (!current) {
    throw new Error("Expected a Pi bridge WebSocket");
  }
  return current;
}

async function openPiSocket(capabilities: Record<string, boolean>) {
  const current = socket();
  await act(async () => current.dispatchEvent(new Event("open")));
  await send({ type: "hello", protocol_version: 1, capabilities });
  return current;
}

async function send(record: Record<string, unknown>) {
  await act(async () => {
    socket().dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) }));
  });
}

function sentRecords(current: TestSocket) {
  return current.send.mock.calls.map(
    ([data]) => JSON.parse(data as string) as Record<string, unknown>,
  );
}

async function renderCards(capabilities: Record<string, boolean> = { generic_dialogs: true }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PiBridgeProvider paneId={PANE_ID} connectionKey="connection-1" wsUrl={(path) => path}>
        <PiDialogCards paneId={PANE_ID} />
      </PiBridgeProvider>,
    );
  });
  const pi = await openPiSocket(capabilities);
  const snapshotRequest = sentRecords(pi).find((record) => record.type === "get_snapshot");
  await send({ type: "response", id: snapshotRequest?.id, ok: true, result: SNAPSHOT });
  return { container, pi };
}

function button(container: HTMLElement, name: string | RegExp) {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    typeof name === "string"
      ? (candidate.textContent ?? "").startsWith(name)
      : name.test(candidate.textContent ?? ""),
  );
  if (!match) {
    throw new Error(`No button matching ${String(name)}`);
  }
  return match;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function type(element: Element, value: string) {
  await act(async () => {
    const field = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PiDialogCards (Seam 3)", () => {
  it("renders one deduped select card with a countdown and sends the chosen option", async () => {
    const { container, pi } = await renderCards();
    await send({ type: "dialog_open", dialog: QUESTION });
    await send({ type: "dialog_open", dialog: SELECT });
    await send({ type: "dialog_open", dialog: SELECT });

    expect(container.querySelectorAll("[data-pi-dialog-cards]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-pi-dialog-card]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-pi-question-card]")).toHaveLength(1);
    expect(container.textContent).toContain("Choose a mode");
    expect(container.textContent).toContain("Pick one");
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).toContain("3s remaining");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toContain("2s remaining");

    await click(button(container, "Safe"));
    expect(sentRecords(pi).find((record) => record.type === "dialog_answer")).toMatchObject({
      dialog_id: "generic-1",
      value: "Safe",
    });

    await send({ type: "dialog_closed", id: "generic-1", resolution: "timeout" });
    expect(container.querySelector("[data-pi-dialog-card]")).toBeNull();
    expect(container.querySelector("[data-pi-question-card]")).not.toBeNull();
  });

  it("answers a confirm with a boolean and an input with the typed text", async () => {
    const { container, pi } = await renderCards();
    await send({
      type: "dialog_open",
      dialog: { id: "confirm-1", kind: "confirm", title: "Continue?", message: "Deploy now", timeout_ms: null },
    });
    await click(button(container, "Yes"));
    expect(sentRecords(pi).find((record) => record.type === "dialog_answer")).toMatchObject({
      dialog_id: "confirm-1",
      value: true,
    });

    await send({ type: "dialog_closed", id: "confirm-1", resolution: "answered" });
    await send({
      type: "dialog_open",
      dialog: {
        id: "input-1",
        kind: "input",
        title: "Your name",
        placeholder: "Ada",
        timeout_ms: null,
      },
    });
    const field = container.querySelector<HTMLInputElement>('input[placeholder="Ada"]');
    expect(field).not.toBeNull();
    await type(field!, "Alice");
    await click(button(container, "Send"));
    expect(sentRecords(pi).filter((record) => record.type === "dialog_answer").at(-1)).toMatchObject({
      dialog_id: "input-1",
      value: "Alice",
    });
  });

  it("cancels like Esc and reports when another surface won", async () => {
    const { container, pi } = await renderCards();
    await send({
      type: "dialog_open",
      dialog: { id: "input-2", kind: "input", title: "Name", placeholder: "", timeout_ms: null },
    });
    await click(button(container, /cancel/i));
    expect(sentRecords(pi).find((record) => record.type === "dialog_answer")).toMatchObject({
      dialog_id: "input-2",
      cancel: true,
    });

    await send({
      type: "dialog_open",
      dialog: { id: "select-2", kind: "select", title: "Pick", options: [{ label: "A" }] },
    });
    await click(button(container, "A"));
    const answer = sentRecords(pi).filter((record) => record.type === "dialog_answer").at(-1);
    await act(async () => {
      socket().dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "response", id: answer?.id, ok: true, result: { accepted: false } }),
        }),
      );
    });
    expect(container.textContent).toContain("Another surface answered this dialog first.");
  });

  it("hides generic cards when the capability is off while question cards still render", async () => {
    const { container } = await renderCards({ generic_dialogs: false });
    await send({ type: "dialog_open", dialog: SELECT });
    expect(container.querySelector("[data-pi-dialog-card]")).toBeNull();
    expect(container.textContent).not.toContain("Choose a mode");

    await send({ type: "dialog_open", dialog: QUESTION });
    expect(container.querySelector("[data-pi-question-card]")).not.toBeNull();
    expect(container.textContent).toContain("Which layout should the card use?");
  });
});
