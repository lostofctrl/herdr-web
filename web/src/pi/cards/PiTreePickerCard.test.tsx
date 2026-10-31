/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiBridgeProvider } from "../PiBridgeContext";
import { PiTreePickerCards } from "./PiTreePickerCard";

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

const PICKER = {
  id: "tree-1",
  session_id: "session-1",
  leaf_id: "entry-2",
  title: "Pi session tree",
  nodes: [
    { entry_id: "entry-1", label: "user: plan the picker", depth: 0, current: false },
    { entry_id: "entry-2", label: "assistant: implemented", depth: 1, current: true },
    { entry_id: "entry-3", label: "[tool] bash", depth: 2, current: false },
  ],
  omitted: 4,
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

async function renderPicker() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PiBridgeProvider paneId={PANE_ID} connectionKey="connection-1" wsUrl={(path) => path}>
        <PiTreePickerCards paneId={PANE_ID} />
      </PiBridgeProvider>,
    );
  });
  const pi = socket();
  await act(async () => pi.dispatchEvent(new Event("open")));
  await send({
    type: "hello",
    protocol_version: 1,
    capabilities: { session_tree_picker: true },
  });
  const snapshotRequest = sentRecords(pi).find((record) => record.type === "get_snapshot");
  await send({ type: "response", id: snapshotRequest?.id, ok: true, result: SNAPSHOT });
  return { container, pi };
}

function button(container: HTMLElement, matches: (label: string) => boolean) {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    matches(candidate.textContent ?? ""),
  );
  if (!match) {
    throw new Error("No matching button");
  }
  return match;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function respondAccepted(pi: TestSocket) {
  const request = sentRecords(pi).at(-1);
  await send({ type: "response", id: request?.id, ok: true, result: { accepted: true } });
}

describe("PiTreePickerCards", () => {
  it("stays hidden until Pi publishes a picker", async () => {
    const { container } = await renderPicker();
    expect(container.querySelector("[data-pi-tree-picker]")).toBeNull();
  });

  it("renders every published entry with its depth and current marker", async () => {
    const { container } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });

    const labels = [...container.querySelectorAll(".pi-dialog-card-option-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["user: plan the picker", "assistant: implemented", "[tool] bash"]);
    const current = container.querySelector('[data-entry-id="entry-2"]');
    expect(current?.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).toContain("4 entries are only in the terminal /tree picker.");
  });

  it("shows the pinned current row and omitted count in a long published tree", async () => {
    const { container } = await renderPicker();
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      entry_id: index === 199 ? "entry-204" : `entry-${index}`,
      label: index === 199 ? "assistant: live leaf" : `user: message ${index}`,
      depth: 0,
      current: index === 199,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, leaf_id: "entry-204", nodes, omitted: 5 } });
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("assistant: live leaf");
    expect(container.textContent).toContain("5 entries are only in the terminal /tree picker.");
  });

  it("filters twelve published rows case-insensitively and keeps the omitted notice", async () => {
    const { container } = await renderPicker();
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      entry_id: `entry-${index}`,
      label: index === 3 ? "Assistant: Special result" : `user: message ${index}`,
      depth: 0,
      current: index === 0,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes: nodes.slice(0, 11) } });
    expect(container.querySelector("input")).toBeNull();
    await send({ type: "tree_picker_open", picker: { ...PICKER, id: "tree-12", nodes } });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter published entries"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SPECIAL");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(1);
    expect(container.textContent).toContain("Assistant: Special result");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No published entries match");
    expect(container.textContent).toContain("4 entries are only in the terminal /tree picker.");
  });

  it("requires an explicit selection before Enter answers a filtered tree", async () => {
    const { container, pi } = await renderPicker();
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      entry_id: `entry-${index}`, label: `user: message ${index}`, depth: 0, current: index === 0,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes } });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "message 1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(container.querySelector('[data-selected="true"]')).toBeNull();
    expect(sentRecords(pi).filter((record) => record.type === "tree_picker_answer")).toHaveLength(0);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(container.querySelector('[data-selected="true"]')?.getAttribute("data-entry-id")).toBe("entry-1");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sentRecords(pi).filter((record) => record.type === "tree_picker_answer")).toMatchObject([
      { picker_id: "tree-1", entry_id: "entry-1" },
    ]);
  });

  it("selects visible filtered rows with both arrow keys from the filter", async () => {
    const { container, pi } = await renderPicker();
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      entry_id: `entry-${index}`, label: `user: message ${index}`, depth: 0, current: index === 0,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes } });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "message 1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    expect(container.querySelector('[data-selected="true"]')).toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(container.querySelector('[data-selected="true"]')?.getAttribute("data-entry-id")).toBe("entry-1");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(container.querySelector('[data-selected="true"]')?.getAttribute("data-entry-id")).toBe("entry-10");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(container.querySelector('[data-selected="true"]')?.getAttribute("data-entry-id")).toBe("entry-1");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sentRecords(pi).at(-1)).toMatchObject({ type: "tree_picker_answer", entry_id: "entry-1" });
    expect(input.disabled).toBe(true);
  });

  it("selects the last visible row on ArrowUp when nothing is selected", async () => {
    const { container, pi } = await renderPicker();
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      entry_id: `entry-${index}`, label: `user: message ${index}`, depth: 0, current: index === 0,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes } });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "message 1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-selected="true"]')?.getAttribute("data-entry-id")).toBe("entry-11");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sentRecords(pi).filter((record) => record.type === "tree_picker_answer")).toMatchObject([
      { picker_id: "tree-1", entry_id: "entry-11" },
    ]);
  });

  it("does not apply an unfinished IME composition to the filter", async () => {
    const { container } = await renderPicker();
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      entry_id: `entry-${index}`, label: `user: message ${index}`, depth: 0, current: index === 0,
    }));
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes } });
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    });
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(12);
    await act(async () => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "missing" })));
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(0);
  });

  it("renders readable and disambiguated labels and answers with the original id", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: { ...PICKER, nodes: [
      { entry_id: "model-1", label: "Model: anthropic/claude-sonnet", depth: 0, current: false },
      { entry_id: "thinking-1", label: "Thinking: high", depth: 0, current: false },
      { entry_id: "summary-1", label: "Branch summary: Earlier work", depth: 0, current: false },
      { entry_id: "abcd1000", label: "user: repeat [abcd1]", depth: 0, current: false },
      { entry_id: "abcd2000", label: "user: repeat [abcd2]", depth: 0, current: false },
    ] } });
    expect([...container.querySelectorAll(".pi-dialog-card-option-label")].map((node) => node.textContent)).toEqual([
      "Model: anthropic/claude-sonnet", "Thinking: high", "Branch summary: Earlier work",
      "user: repeat [abcd1]", "user: repeat [abcd2]",
    ]);
    await click(button(container, (label) => label.startsWith("user: repeat [abcd2]")));
    expect(sentRecords(pi).at(-1)).toMatchObject({
      type: "tree_picker_answer", picker_id: "tree-1", entry_id: "abcd2000",
    });
    await respondAccepted(pi);
  });

  it("does not handle composing keys or keys outside the card", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });
    expect(container.querySelector("input")).toBeNull();
    const first = container.querySelector<HTMLButtonElement>('[data-entry-id="entry-1"]')!;
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    await act(async () => {
      outside.focus();
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }));
    });
    expect(sentRecords(pi).filter((record) => String(record.type).startsWith("tree_picker_"))).toHaveLength(0);
    expect(document.activeElement).toBe(first);
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(sentRecords(pi).at(-1)).toMatchObject({ type: "tree_picker_cancel", picker_id: "tree-1" });
  });

  it("moves the keyboard selection inside the card and sends one request if a click races Enter", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });
    const first = container.querySelector<HTMLButtonElement>('[data-entry-id="entry-1"]')!;
    const second = container.querySelector<HTMLButtonElement>('[data-entry-id="entry-2"]')!;
    await act(async () => {
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(second);
    await act(async () => {
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.activeElement).toBe(second);
    expect(sentRecords(pi).filter((record) => record.type === "tree_picker_answer")).toMatchObject([
      { picker_id: "tree-1", entry_id: "entry-2" },
    ]);
    expect(second.disabled).toBe(true);
  });

  it("answers with the chosen entry id and the picker id", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });

    await click(button(container, (label) => label.startsWith("[tool] bash")));
    const request = sentRecords(pi).at(-1);
    expect(request).toMatchObject({
      type: "tree_picker_answer",
      picker_id: "tree-1",
      entry_id: "entry-3",
    });
    await respondAccepted(pi);
    expect(container.querySelector(".pi-dialog-error")).toBeNull();
  });

  it("reports that Pi stopped waiting when the answer is refused", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });

    await click(button(container, (label) => label.startsWith("user:")));
    const request = sentRecords(pi).at(-1);
    await send({ type: "response", id: request?.id, ok: true, result: { accepted: false } });
    expect(container.querySelector(".pi-dialog-error")?.textContent).toBe(
      "Pi is no longer waiting for this picker.",
    );
  });

  it("sends one request when the same entry is tapped twice", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });

    const entry = button(container, (label) => label.startsWith("user:"));
    await act(async () => {
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const answers = sentRecords(pi).filter((record) => record.type === "tree_picker_answer");
    expect(answers).toHaveLength(1);
  });

  it("cancels without navigating and disappears when Pi closes the picker", async () => {
    const { container, pi } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });

    await click(button(container, (label) => label === "Cancel"));
    expect(sentRecords(pi).at(-1)).toMatchObject({
      type: "tree_picker_cancel",
      picker_id: "tree-1",
    });
    await respondAccepted(pi);
    await send({ type: "tree_picker_closed", outcome: "answered" });
    expect(container.querySelector("[data-pi-tree-picker]")).toBeNull();
  });

  it("replaces a stale picker with the newer one", async () => {
    const { container } = await renderPicker();
    await send({ type: "tree_picker_open", picker: PICKER });
    await send({
      type: "tree_picker_open",
      picker: { ...PICKER, id: "tree-2", nodes: [PICKER.nodes[0]], omitted: 0 },
    });

    expect(container.querySelectorAll("[data-pi-tree-picker]")).toHaveLength(1);
    expect(container.querySelector('[data-entry-id="entry-3"]')).toBeNull();
  });
});
