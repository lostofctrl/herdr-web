/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiBridgeProvider, usePiBridge } from "./PiBridgeContext";

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

async function closePiSocket(code: number) {
  await act(async () => {
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: "" });
    socket().dispatchEvent(event);
  });
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

function snapshotFrames(current: TestSocket) {
  return sentRecords(current).filter((record) => record.type === "get_snapshot");
}

const SNAPSHOT = {
  state: {
    busy: "idle",
    model: { provider: "anthropic", id: "sonnet" },
    thinking_level: "medium",
    models: [{ provider: "anthropic", id: "sonnet", label: "Sonnet" }],
    thinking_levels: ["off", "medium", "high"],
    cwd: "/repo",
  },
  catalog: {
    commands: [{ name: "/compact", description: "Compact", source: "builtin" }],
    skills: [{ name: "tdd", description: "Test first", source: "skill" }],
  },
  dialogs: [],
  assistant_message: "initial answer",
};

function Probe({ paneId }: { paneId: string }) {
  const bridge = usePiBridge(paneId);
  const [results, setResults] = useState<string[]>([]);
  const run = (name: string, action: Promise<unknown>) => {
    void action.then((value) => setResults((current) => [...current, `${name}:${JSON.stringify(value)}`]));
  };
  return (
    <div>
      <div data-testid="status">{bridge?.status ?? "none"}</div>
      <div data-testid="busy">{bridge?.state?.busy ?? "none"}</div>
      <div data-testid="model">{JSON.stringify(bridge?.state?.model ?? null)}</div>
      <div data-testid="commands">{JSON.stringify(bridge?.catalog?.commands ?? null)}</div>
      <div data-testid="dialogs">{JSON.stringify(bridge?.dialogs ?? null)}</div>
      <div data-testid="assistant">{bridge?.assistantMessage ?? "none"}</div>
      <div data-testid="capabilities">{JSON.stringify(bridge?.capabilities ?? null)}</div>
      <div data-testid="results">{JSON.stringify(results)}</div>
      <button aria-label="set model" onClick={() => bridge && run("model", bridge.setModel("openai", "gpt-5"))} />
      <button aria-label="set thinking" onClick={() => bridge && run("thinking", bridge.setThinkingLevel("high"))} />
      <button aria-label="list files" onClick={() => bridge && run("files", bridge.listFiles("src", 999))} />
      <button
        aria-label="cancel dialog"
        onClick={() => bridge && run("answer", bridge.answerDialog("d1", { cancel: true }))}
      />
    </div>
  );
}

async function renderProbe({
  paneId = PANE_ID,
  enabled = true,
  resumeToken = 0,
}: {
  paneId?: string;
  enabled?: boolean;
  resumeToken?: number;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PiBridgeProvider
        paneId={paneId}
        connectionKey="connection-1"
        resumeToken={resumeToken}
        enabled={enabled}
        wsUrl={(path, query) => (query ? `${path}?${query}` : path)}
      >
        <Probe paneId={paneId} />
      </PiBridgeProvider>,
    );
  });
  return { container, root };
}

function text(container: HTMLElement, testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("PiBridgeProvider (Seam 3)", () => {
  it("requests a snapshot on open and applies state, catalog, dialogs and assistant updates", async () => {
    const { container } = await renderProbe();
    expect(TestSocket.instances).toHaveLength(1);
    expect(socket().url).toBe(`/ws/pi?pane_id=${PANE_ID}`);

    const pi = await openPiSocket();
    expect(snapshotFrames(pi)).toEqual([
      { type: "get_snapshot", id: expect.any(String) },
    ]);
    expect(text(container, "status")).toBe("online");

    const snapshotId = snapshotFrames(pi)[0].id as string;
    await send({ type: "response", id: snapshotId, ok: true, result: SNAPSHOT });
    expect(text(container, "busy")).toBe("idle");
    expect(text(container, "model")).toBe('{"provider":"anthropic","id":"sonnet"}');
    expect(text(container, "commands")).toContain("/compact");
    expect(text(container, "assistant")).toBe("initial answer");

    await send({
      type: "hello",
      protocol_version: 1,
      capabilities: { generic_dialogs: true, list_files: true },
    });
    expect(text(container, "capabilities")).toContain("generic_dialogs");

    await send({
      type: "state",
      busy: "dialog",
      model: { provider: "openai", id: "gpt-5" },
      thinking_level: "high",
      models: [],
      thinking_levels: ["high"],
      cwd: "/other",
    });
    expect(text(container, "busy")).toBe("dialog");
    expect(text(container, "model")).toBe('{"provider":"openai","id":"gpt-5"}');

    await send({
      type: "catalog",
      commands: [{ name: "/new", description: "New", source: "builtin" }],
      skills: [],
    });
    expect(text(container, "commands")).toContain("/new");

    await send({ type: "dialog_open", dialog: { id: "d1", kind: "confirm", title: "Continue?" } });
    expect(text(container, "dialogs")).toContain('"id":"d1"');
    await send({ type: "dialog_open", dialog: { id: "d1", kind: "confirm", title: "Changed?" } });
    expect(text(container, "dialogs")).toContain("Changed?");
    await send({ type: "dialog_closed", id: "d1", resolution: "answered" });
    expect(text(container, "dialogs")).toBe("[]");

    await send({ type: "assistant_message", text: "next answer" });
    expect(text(container, "assistant")).toBe("next answer");
  });

  it("correlates get_snapshot, set_model, set_thinking_level, list_files and dialog_answer responses", async () => {
    const { container } = await renderProbe();
    const pi = await openPiSocket();
    await send({ type: "response", id: snapshotFrames(pi)[0].id, ok: true, result: SNAPSHOT });

    for (const label of ["set model", "set thinking", "list files", "cancel dialog"]) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
      });
    }

    const requests = sentRecords(pi).filter((record) => record.type !== "get_snapshot");
    expect(requests.map((record) => record.type)).toEqual([
      "set_model",
      "set_thinking_level",
      "list_files",
      "dialog_answer",
    ]);
    expect(requests[0]).toMatchObject({ provider: "openai", model: "gpt-5" });
    expect(requests[1]).toMatchObject({ level: "high" });
    expect(requests[2]).toMatchObject({ query: "src", limit: 200 });
    expect(requests[3]).toMatchObject({ dialog_id: "d1", cancel: true });
    expect(new Set(requests.map((record) => record.id)).size).toBe(4);

    await send({ type: "response", id: requests[3].id, ok: true, result: { accepted: false } });
    await send({ type: "response", id: requests[2].id, ok: true, result: { files: [{ path: "src/a.ts" }] } });
    await send({ type: "response", id: requests[1].id, ok: true, result: {} });
    await send({ type: "response", id: requests[0].id, ok: true, result: {} });

    const results = JSON.parse(text(container, "results")) as string[];
    expect(results).toContain('answer:{"accepted":false}');
    expect(results).toContain('files:[{"path":"src/a.ts"}]');
    expect(results).toContain("thinking:undefined");
    expect(results).toContain("model:undefined");
  });

  it("surfaces Bridge Offline on close 4500 and recovers by retrying with backoff", async () => {
    const { container } = await renderProbe();
    const first = await openPiSocket();
    await send({ type: "response", id: snapshotFrames(first)[0].id, ok: true, result: SNAPSHOT });

    await closePiSocket(4500);
    expect(text(container, "status")).toBe("offline");
    expect(TestSocket.instances).toHaveLength(1);

    await act(async () => vi.advanceTimersByTime(499));
    expect(TestSocket.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(TestSocket.instances).toHaveLength(2);

    const second = await openPiSocket();
    expect(text(container, "status")).toBe("online");
    expect(snapshotFrames(second)).toHaveLength(1);
    await send({
      type: "response",
      id: snapshotFrames(second)[0].id,
      ok: true,
      result: { ...SNAPSHOT, assistant_message: "after reconnect" },
    });
    expect(text(container, "assistant")).toBe("after reconnect");
  });

  it("treats a failed connect as Bridge Offline and resyncs on visibility resume", async () => {
    const { container } = await renderProbe();
    await closePiSocket(1006);
    expect(text(container, "status")).toBe("offline");

    await act(async () => vi.advanceTimersByTime(500));
    const retried = await openPiSocket();
    expect(text(container, "status")).toBe("online");
    expect(snapshotFrames(retried)).toHaveLength(1);
    await send({ type: "response", id: snapshotFrames(retried)[0].id, ok: true, result: SNAPSHOT });

    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(snapshotFrames(retried)).toHaveLength(2);
    if (originalVisibility) {
      Object.defineProperty(document, "visibilityState", originalVisibility);
    }
  });

  it("reports an unknown pane without retrying", async () => {
    const { container } = await renderProbe();
    await closePiSocket(4501);
    expect(text(container, "status")).toBe("unknown-pane");

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(TestSocket.instances).toHaveLength(1);
  });
});
