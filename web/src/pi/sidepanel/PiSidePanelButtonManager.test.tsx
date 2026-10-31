/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PiSidePanelButtonManager, type ButtonManagerModel } from "./PiSidePanelButtonManager";

const base: ButtonManagerModel = {
  schema_version: 1, revision: 4,
  buttons: [{ id: "custom-1", title: "Review", icon: { type: "glyph", text: "R" }, action: { type: "prompt", text: "review", delivery: "insert" } }],
  pinned: ["abort", "custom-1", "chat-log"],
};
const catalog = { commands: [{ name: "compact", description: "Compact", source: "builtin" }], skills: [{ name: "graft", description: "Graph", source: "skill" }] };
let root: Root;
let container: HTMLDivElement;
const mutate = vi.fn<(model: ButtonManagerModel) => Promise<void>>().mockResolvedValue(undefined);
const activate = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mutate.mockReset().mockResolvedValue(undefined); activate.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(model = base, error: string | null = null) {
  await act(async () => root.render(<PiSidePanelButtonManager model={model} status="ready" error={error} catalog={catalog} skillsEnabled onMutate={mutate} onActivate={activate} />));
}
function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name);
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
}

it("shows pinned actions in stored order and all entries including pinned in the list", async () => {
  await render();
  const pins = container.querySelector('[aria-label="Pi quick actions"]')!;
  expect([...pins.querySelectorAll("button")].map((el) => el.getAttribute("aria-label"))).toEqual(["Abort Pi", "Review", "Open chat log", "Manage Pi buttons"]);
  await click("Review"); expect(activate).toHaveBeenCalledWith(base.buttons[0].action, "custom-1");
  await click("Manage Pi buttons");
  expect(button("Unpin Abort Pi")).toBeTruthy(); expect(button("Pin Compact Pi session")).toBeTruthy();
  expect(button("Unpin Review")).toBeTruthy(); expect(container.querySelector('[aria-label="Delete Abort Pi"]')).toBeNull();
  await click("Pin Compact Pi session");
  expect(mutate).toHaveBeenCalledWith({ ...base, pinned: [...base.pinned, "compact"] });
});

it("runs unpinned entries from the management list", async () => {
  await render(); await click("Manage Pi buttons"); await click("Run Compact Pi session");
  expect(activate).toHaveBeenCalledWith({ type: "builtin", id: "compact" }, "compact");
});

it("keeps built-in controls available on an older bridge", async () => {
  await act(async () => root.render(<PiSidePanelButtonManager model={base} status="unsupported" error={null} catalog={catalog} skillsEnabled onMutate={mutate} onActivate={activate} />));
  expect(button("Abort Pi").disabled).toBe(false);
  await click("Abort Pi"); expect(activate).toHaveBeenCalledWith({ type: "builtin", id: "abort" }, "abort");
  expect(mutate).not.toHaveBeenCalled();
});

it("adds a catalog trigger without discarding the existing prompt", async () => {
  await render(); await click("Manage Pi buttons"); await click("Add button");
  await input("Title", "Graph"); await input("Action", "prompt"); await input("Prompt", "review this"); await input("Command or skill", "/skill:graft");
  expect((container.querySelector('[aria-label="Prompt"]') as HTMLTextAreaElement).value).toBe("/skill:graft review this");
});

it("creates a custom prompt from the live catalog and delegates literal text", async () => {
  await render(); await click("Manage Pi buttons"); await click("Add button");
  await input("Title", "Graph"); await input("Action", "prompt"); await input("Command or skill", "/skill:graft"); await input("Delivery", "send");
  await click("Save button");
  const next = mutate.mock.calls[0][0];
  expect(next.revision).toBe(4); expect(next.buttons).toHaveLength(2);
  expect(next.buttons[1].id).toMatch(/^custom-/);
  expect(next.buttons[1]).toMatchObject({ title: "Graph", action: { type: "prompt", text: "/skill:graft", delivery: "send" } });
  expect(container.textContent).toContain("terminal editor may contain unseen typed text");
  expect(container.textContent).toContain("not secret");
});

it("edits a custom button into a built-in action without changing its identity or pin", async () => {
  await render(); await click("Manage Pi buttons"); await click("Edit Review");
  await input("Title", "Pause"); await input("Icon type", "lucide"); await input("Icon", "zap");
  await input("Action", "builtin"); await input("Built-in action", "resume"); await click("Save button");
  expect(mutate).toHaveBeenCalledWith({ ...base, buttons: [{ id: "custom-1", title: "Pause", icon: { type: "lucide", name: "zap" }, action: { type: "builtin", id: "resume" } }] });
});

it("confirms deletion and removes its pin only after confirmation", async () => {
  await render(); await click("Manage Pi buttons"); await click("Delete Review");
  expect(mutate).not.toHaveBeenCalled(); await click("Cancel deletion"); expect(mutate).not.toHaveBeenCalled();
  await click("Delete Review"); await click("Confirm delete");
  expect(mutate).toHaveBeenCalledWith({ ...base, buttons: [], pinned: ["abort", "chat-log"] });
});

it("preserves edited fields when a mutation conflicts and when the model refreshes", async () => {
  mutate.mockRejectedValueOnce(new Error("Revision conflict"));
  await render(); await click("Manage Pi buttons"); await click("Edit Review"); await input("Title", "Unsaved title"); await click("Save button");
  expect(container.textContent).toContain("Revision conflict"); expect(container.querySelector('[aria-label="Title"]')).toBeTruthy();
  await render({ ...base, revision: 5 }, "Revision conflict");
  expect((container.querySelector('[aria-label="Title"]') as HTMLInputElement).value).toBe("Unsaved title");
  await click("Save button");
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("changed while you were editing");
  expect((container.querySelector('[aria-label="Title"]') as HTMLInputElement).value).toBe("Unsaved title");
});

it("rejects invalid titles, glyphs and oversized UTF-8 prompts without mutation", async () => {
  await render(); await click("Manage Pi buttons"); await click("Add button");
  await input("Title", " "); await click("Save button"); expect(mutate).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).toBeTruthy();
  await input("Title", "X"); await input("Icon type", "glyph"); await input("Glyph", "x".repeat(17)); await click("Save button"); expect(mutate).not.toHaveBeenCalled();
  await input("Glyph", "✓"); await input("Action", "prompt"); await input("Prompt", "é".repeat(4097)); await click("Save button"); expect(mutate).not.toHaveBeenCalled();
  await input("Prompt", "unsafe\ttext"); await click("Save button"); expect(mutate).not.toHaveBeenCalled();
});

it("blocks writes when unsupported, loading, or in error and shows the supplied error", async () => {
  for (const status of ["unsupported", "loading", "error"] as const) {
    await act(async () => root.render(<PiSidePanelButtonManager model={base} status={status} error={status === "error" ? "Storage unavailable" : null} catalog={catalog} skillsEnabled onMutate={mutate} onActivate={activate} />));
    await click("Manage Pi buttons");
    expect(button("Add button").disabled).toBe(true); expect(button("Unpin Review").disabled).toBe(true);
    if (status === "unsupported") expect(container.textContent).toContain("not supported");
    if (status === "loading") expect(container.textContent).toContain("Loading buttons");
    if (status === "error") expect(container.textContent).toContain("Storage unavailable");
    await click("Close");
  }
  expect(mutate).not.toHaveBeenCalled();
});

it("returns focus on Escape without activating an action", async () => {
  await render(); const trigger = button("Manage Pi buttons"); trigger.focus(); await click("Manage Pi buttons");
  const outer = vi.fn(); document.body.addEventListener("keydown", outer);
  await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  document.body.removeEventListener("keydown", outer);
  expect(outer).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger); expect(activate).not.toHaveBeenCalled();
  await click("Manage Pi buttons"); await click("Edit Review");
  await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(button("Edit Review"));
});
