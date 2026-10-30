/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationContext } from "./ConversationContext";
import type { PiConversation, PiConversationExchange } from "../piConversation";

const bridge = vi.hoisted(() => ({ current: null as null | { status: string; conversation: unknown } }));
vi.mock("../PiBridgeContext", () => ({ usePiBridge: () => bridge.current }));

let root: Root;
let container: HTMLDivElement;
let scrollHeight = 1000;

const exchange = (user: string, assistant: string): PiConversationExchange => ({
  user, assistant, status: "complete", user_truncated: false, assistant_truncated: false,
});
const conversation = (): PiConversation => ({
  type: "conversation_update", schema_version: 1, epoch: "epoch-1", session_id: "session-1",
  leaf_id: "leaf-1", selection_generation: 1, revision: 1, availability: "ready", reason: null,
  exchanges: [exchange("first prompt", "first answer"), exchange("latest prompt", "latest answer")],
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scrollHeight = 1000;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  bridge.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(value: PiConversation | null, status = "online") {
  bridge.current = { status, conversation: value };
  await act(async () => root.render(<ConversationContext paneId="pane-a" />));
}

function readingBodies() {
  const articles = [...container.querySelectorAll<HTMLElement>("article")];
  expect(articles).toHaveLength(2);
  return articles.map((article) => {
    const header = article.querySelector("header");
    const body = article.querySelector<HTMLElement>('[tabindex="0"]');
    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    expect(body?.contains(header)).toBe(false);
    return body!;
  });
}

describe("ConversationContext prototype B presentation", () => {
  it("formats assistant Markdown safely while keeping user text literal", async () => {
    const value = conversation();
    value.exchanges[1] = exchange("**literal user**", "**strong answer**\n\n```ts\nconst answer = 42;\n```\n\n[unsafe](javascript:alert(1)) ![image](https://example.com/x.png) <script>alert(1)</script>");
    await render(value);
    const latest = container.querySelectorAll("article")[1];
    expect(latest.textContent).toContain("**literal user**");
    expect(latest.querySelector("strong")?.textContent).not.toBe("literal user");
    expect([...latest.querySelectorAll("strong")].some((node) => node.textContent === "strong answer")).toBe(true);
    expect(latest.querySelector("pre code")?.textContent).toContain("const answer = 42;");
    expect(latest.querySelector("img, script, a[href^='javascript:']")).toBeNull();
  });

  it("re-pins on reading body resize only while pinned", async () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { callbacks.push(cb); } observe() {} disconnect() {} });
    try {
      await render(conversation());
      const latest = readingBodies()[1];
      scrollHeight = 1400;
      await act(async () => callbacks.forEach((cb) => cb()));
      expect(latest.scrollTop).toBeGreaterThanOrEqual(1300);
      latest.scrollTop = 100;
      await act(async () => latest.dispatchEvent(new Event("scroll")));
      scrollHeight = 1800;
      await act(async () => callbacks.forEach((cb) => cb()));
      expect(latest.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps separate focusable reading bodies, tails latest initially, follows only while pinned, and resets on new authority", async () => {
    let value = conversation();
    await render(value);
    let [first, latest] = readingBodies();
    expect(first.scrollTop).toBe(0);
    expect(latest.scrollTop).toBeGreaterThanOrEqual(900);
    first.scrollTop = 33;
    latest.scrollTop = 900;
    await act(async () => latest.dispatchEvent(new Event("scroll")));
    scrollHeight = 1300;
    value = { ...value, revision: 2, leaf_id: "leaf-2", exchanges: [value.exchanges[0], { ...value.exchanges[1], assistant: "more text" }] };
    await render(value);
    [first, latest] = readingBodies();
    expect(latest.scrollTop).toBeGreaterThanOrEqual(1200);
    expect(first.scrollTop).toBe(33);
    latest.scrollTop = 150;
    await act(async () => latest.dispatchEvent(new Event("scroll")));
    scrollHeight = 1600;
    value = { ...value, revision: 3, exchanges: [value.exchanges[0], { ...value.exchanges[1], status: "running", assistant: "more text again" }] };
    await render(value);
    [first, latest] = readingBodies();
    expect(latest.scrollTop).toBe(150);
    expect(first.scrollTop).toBe(33);
    await render({ ...value, revision: 4, leaf_id: "leaf-3" });
    expect(readingBodies()[1].scrollTop).toBe(150);
    await render({ ...value, epoch: "epoch-2", session_id: "session-2", selection_generation: 2 });
    expect(readingBodies()[1].scrollTop).toBeGreaterThanOrEqual(1500);
  });

  it("renders one exchange once and fails closed for empty and unavailable snapshots", async () => {
    const value = conversation();
    await render({ ...value, exchanges: [value.exchanges[1]] });
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).toContain("First / current exchange");
    await render({ ...value, exchanges: [] });
    expect(container.textContent).toContain("No recorded exchanges yet");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    await render({ ...value, availability: "unavailable", reason: "selection_changing", exchanges: [] });
    expect(container.textContent).toContain("Conversation context unavailable");
    await render(value, "offline");
    expect(container.textContent).toContain("Bridge Offline");
    expect(container.textContent).not.toContain("latest answer");
  });
});
