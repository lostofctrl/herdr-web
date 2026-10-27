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
      options: [
        { label: "Stack", description: "One column", preview: "<Stack preview>" },
        { label: "Split", description: "Two columns", preview: "" },
      ],
    },
    {
      question: "Which surfaces ship?",
      header: "Surfaces",
      multiSelect: true,
      options: [
        { label: "Phone", description: "Touch card", preview: "" },
        { label: "Desktop", description: "Wide card", preview: "" },
      ],
    },
  ],
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

async function openPiSocket() {
  const current = socket();
  await act(async () => current.dispatchEvent(new Event("open")));
  return current;
}

async function send(record: Record<string, unknown>) {
  await act(async () => {
    socket().dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) }));
  });
}

async function closePiSocket(code: number) {
  await act(async () => {
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    socket().dispatchEvent(event);
  });
}

function sentRecords(current: TestSocket) {
  return current.send.mock.calls.map(
    ([data]) => JSON.parse(data as string) as Record<string, unknown>,
  );
}

async function renderCards() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PiBridgeProvider
        paneId={PANE_ID}
        connectionKey="connection-1"
        wsUrl={(path) => path}
      >
        <PiDialogCards paneId={PANE_ID} />
      </PiBridgeProvider>,
    );
  });
  const pi = await openPiSocket();
  const snapshotRequest = sentRecords(pi).find((record) => record.type === "get_snapshot");
  await send({
    type: "response",
    id: snapshotRequest?.id,
    ok: true,
    result: SNAPSHOT,
  });
  return { container, pi };
}

async function openQuestion(pi: TestSocket) {
  await send({ type: "dialog_open", dialog: QUESTION });
  return pi;
}

function button(container: HTMLElement, name: string | RegExp) {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  const match = buttons.find((candidate) =>
    typeof name === "string" ? (candidate.textContent ?? "").startsWith(name) : name.test(candidate.textContent ?? ""),
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
    const field = element as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PiQuestionCards (Seam 3)", () => {
  it("renders questions, descriptions, previews and sends a single-select answer", async () => {
    const { container, pi } = await renderCards();
    await openQuestion(pi);

    expect(container.textContent).toContain("Which layout should the card use?");
    expect(container.textContent).toContain("Layout");
    expect(container.textContent).toContain("One column");
    expect(container.textContent).toContain("Which surfaces ship?");
    expect(container.textContent).toContain("Touch card");
    expect(container.querySelectorAll('[aria-label*="Free-text answer"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("<Stack preview>");

    await click(button(container, "Stack"));
    expect(container.textContent).toContain("<Stack preview>");

    await click(button(container, "Phone"));
    await click(button(container, "Desktop"));
    expect(button(container, "Phone").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Desktop").getAttribute("aria-pressed")).toBe("true");

    await click(button(container, "Send answer"));

    const answer = sentRecords(pi).find((record) => record.type === "dialog_answer");
    expect(answer).toMatchObject({
      dialog_id: "tool-1",
      value: {
        answers: [
          { questionIndex: 0, optionIndexes: [0] },
          { questionIndex: 1, optionIndexes: [0, 1] },
        ],
      },
    });
  });

  it("sends free text for a single-select question and removes the card on dialog_closed", async () => {
    const { container, pi } = await renderCards();
    await openQuestion(pi);

    await click(button(container, "Stack"));
    const freeText = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Free-text answer for Layout"]',
    );
    expect(freeText).not.toBeNull();
    await type(freeText!, "Compact on phones");
    expect(button(container, "Stack").getAttribute("aria-pressed")).toBe("false");

    await click(button(container, "Desktop"));
    await click(button(container, "Send answer"));

    const answer = sentRecords(pi).find((record) => record.type === "dialog_answer");
    expect(answer).toMatchObject({
      value: {
        answers: [
          { questionIndex: 0, text: "Compact on phones" },
          { questionIndex: 1, optionIndexes: [1] },
        ],
      },
    });

    await send({ type: "dialog_closed", id: "tool-1", resolution: "answered" });
    expect(container.querySelector("[data-pi-question-card]")).toBeNull();
  });

  it("sends a cancel request shaped like Esc", async () => {
    const { container, pi } = await renderCards();
    await openQuestion(pi);

    await click(button(container, /cancel/i));

    const answer = sentRecords(pi).find((record) => record.type === "dialog_answer");
    expect(answer).toMatchObject({ dialog_id: "tool-1", cancel: true });
  });

  it("keeps the card usable and reports Bridge Offline when an answer cannot be sent", async () => {
    const { container, pi } = await renderCards();
    await openQuestion(pi);

    await click(button(container, "Stack"));
    await click(button(container, "Phone"));
    await closePiSocket(4500);
    await click(button(container, "Send answer"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Pi Bridge is offline");
    expect(container.textContent).toContain("Which layout should the card use?");
  });
});

