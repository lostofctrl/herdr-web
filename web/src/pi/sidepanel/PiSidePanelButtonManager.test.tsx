/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PiSidePanelButtonManager, type ButtonManagerModel, type PiSidePanelButtonManagerProps } from "./PiSidePanelButtonManager";

const base: ButtonManagerModel = {
  schema_version: 1, revision: 4,
  buttons: [{ id: "custom-1", title: "Review", icon: { type: "glyph", text: "R" }, action: { type: "prompt", text: "review", delivery: "insert" } }],
  pinned: ["abort", "custom-1", "chat-log"],
};
const catalog = { commands: [{ name: "compact", description: "Reduce context", source: "builtin" }], skills: [{ name: "graft", description: "Graph navigation", source: "skill" }] };
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
async function render(overrides: Partial<PiSidePanelButtonManagerProps> = {}) {
  await act(async () => root.render(<PiSidePanelButtonManager model={base} status="ready" error={null} catalog={catalog} skillsEnabled onMutate={mutate} onActivate={activate} {...overrides} />));
}
function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name);
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function manage() { await click("More Pi buttons"); await click("Manage Pi buttons"); }
async function input(label: string, value: string) {
  const element = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
}
async function key(element: Element, name: string, shiftKey = false) {
  await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })));
}

it("shows only unpinned actions in the menu, invokes and dismisses them", async () => {
  await render({ model: { ...base, pinned: ["abort", "chat-log"] } });
  const pins = container.querySelector('[aria-label="Pi quick actions"]')!;
  expect([...pins.querySelectorAll("button")].map((el) => el.getAttribute("aria-label"))).toEqual(["Abort Pi", "Open chat log", "More Pi buttons"]);
  await click("More Pi buttons");
  const menu = document.querySelector('[role="menu"]')!;
  expect(pins.contains(menu)).toBe(false);
  expect(menu.textContent).toContain("Compact Pi session"); expect(menu.textContent).toContain("Review");
  expect(menu.textContent).not.toContain("Abort Pi"); expect(menu.textContent).not.toContain("Open chat log");
  expect(menu.querySelector("svg")).toBeTruthy();
  await click("Review"); expect(activate).toHaveBeenCalledWith(base.buttons[0].action, "custom-1");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("dismisses the menu on outside pointer and Escape, restoring focus on Escape", async () => {
  await render(); const trigger = button("More Pi buttons"); trigger.focus(); await click("More Pi buttons");
  await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await click("More Pi buttons"); await key(document.querySelector('[role="menu"]')!, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger); expect(activate).not.toHaveBeenCalled();
});

it("opens a body portal modal and manages pins, including pinned entries", async () => {
  await render(); await manage();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.parentElement?.classList.contains("pi-button-manager-backdrop")).toBe(true);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(button("Unpin Abort Pi")).toBeTruthy(); expect(button("Pin Compact Pi session")).toBeTruthy(); expect(button("Unpin Review")).toBeTruthy();
  expect(document.querySelector('[aria-label="Delete Abort Pi"]')).toBeNull();
  await click("Pin Compact Pi session"); expect(mutate).toHaveBeenCalledWith({ ...base, pinned: [...base.pinned, "compact"] });
  await click("Close"); expect(document.activeElement).toBe(button("More Pi buttons"));
});

it("keeps actions runnable from the management list and disables unavailable menu actions", async () => {
  await render({ canActivate: (action) => action.type !== "builtin" || action.id !== "resume" }); await click("More Pi buttons");
  expect(button("Resume Pi session").disabled).toBe(true); await click("Manage Pi buttons"); await click("Run Compact Pi session");
  expect(activate).toHaveBeenCalledWith({ type: "builtin", id: "compact" }, "compact");
});

it("traps modal tab navigation and dismisses only the list backdrop", async () => {
  await render(); await manage();
  const close = button("Close"); close.focus(); await key(close, "Tab");
  expect(document.activeElement).toBe(button("Run Abort Pi"));
  await key(document.activeElement!, "Tab", true); expect(document.activeElement).toBe(close);
  await click("Add button"); await act(async () => document.querySelector<HTMLElement>(".pi-button-manager-backdrop")!.click());
  expect(document.querySelector('[aria-label="Title"]')).toBeTruthy();
  await click("Cancel"); await act(async () => document.querySelector<HTMLElement>(".pi-button-manager-backdrop")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(button("More Pi buttons"));
});

it("hides unavailable unpinned custom actions while retaining builtins on older bridges", async () => {
  await render({ model: { ...base, pinned: ["abort"] }, status: "unsupported" });
  expect(button("Abort Pi").disabled).toBe(false);
  await click("Abort Pi"); expect(activate).toHaveBeenCalledWith({ type: "builtin", id: "abort" }, "abort");
  await click("More Pi buttons"); expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Review");
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Compact Pi session"); expect(mutate).not.toHaveBeenCalled();
});

it("opens the searchable catalog as a dropdown and closes it after selection", async () => {
  await render(); await manage(); await click("Add button"); await input("Action", "prompt");
  const search = document.querySelector<HTMLInputElement>('[aria-label="Command or skill"]')!;
  expect(search.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".pi-trigger-picker-options")).toBeNull();
  await act(async () => search.focus());
  expect(search.getAttribute("aria-expanded")).toBe("true");
  await key(search, "ArrowDown");
  expect(document.activeElement).toBe(button("/compact"));
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(button("/skill:graft"));
  await key(document.activeElement!, "Escape");
  expect(document.activeElement).toBe(search);
  expect(search.getAttribute("aria-expanded")).toBe("false");
  await key(search, "ArrowDown");
  expect(document.activeElement).toBe(button("/compact"));
  await key(document.activeElement!, "Escape");
  await input("Command or skill", "no such command");
  expect(document.body.textContent).toContain("No matching commands or skills");
  await input("Command or skill", "graft"); await click("/skill:graft");
  expect(search.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".pi-trigger-picker-options")).toBeNull();
});

it("searches the catalog by description and trigger, prefixes existing literal prompt, and supports an absent catalog", async () => {
  await render(); await manage(); await click("Add button"); await input("Action", "prompt"); await input("Prompt", "review this");
  await input("Command or skill", "graph navigation"); expect(document.body.textContent).toContain("/skill:graft"); expect(document.body.textContent).not.toContain("/compact");
  await click("/skill:graft"); expect((document.querySelector('[aria-label="Prompt"]') as HTMLTextAreaElement).value).toBe("/skill:graft review this");
  await input("Command or skill", "/compact"); expect(document.body.textContent).toContain("/compact");
  await render({ catalog: null }); expect((document.querySelector('[aria-label="Prompt"]') as HTMLTextAreaElement).value).toBe("/skill:graft review this");
});

it("creates a custom prompt with catalog text and send delivery", async () => {
  await render(); await manage(); await click("Add button"); await input("Title", "Graph"); await input("Action", "prompt");
  await input("Command or skill", "graft"); await click("/skill:graft"); await input("Delivery", "send"); await click("Save button");
  const next = mutate.mock.calls[0][0]; expect(next.revision).toBe(4); expect(next.buttons).toHaveLength(2); expect(next.buttons[1].id).toMatch(/^custom-/);
  expect(next.buttons[1]).toMatchObject({ title: "Graph", action: { type: "prompt", text: "/skill:graft", delivery: "send" } });
  expect(document.body.textContent).toContain("terminal editor may contain unseen typed text"); expect(document.body.textContent).toContain("not secret");
});

it("edits a custom button using the visual Lucide picker without changing its identity or pin", async () => {
  await render(); await manage(); await click("Edit Review"); await input("Title", "Pause"); await input("Icon type", "lucide"); await click("Icon");
  const option = button("zap"); expect(option.querySelector("svg")).toBeTruthy(); await click("zap");
  await input("Action", "builtin"); await input("Built-in action", "resume"); await click("Save button");
  expect(mutate).toHaveBeenCalledWith({ ...base, buttons: [{ id: "custom-1", title: "Pause", icon: { type: "lucide", name: "zap" }, action: { type: "builtin", id: "resume" } }] });
});

it("confirms deletion and removes the pin only after confirmation", async () => {
  await render(); await manage(); await click("Delete Review"); expect(mutate).not.toHaveBeenCalled(); await click("Cancel deletion"); expect(mutate).not.toHaveBeenCalled();
  await click("Delete Review"); await click("Confirm delete"); expect(mutate).toHaveBeenCalledWith({ ...base, buttons: [], pinned: ["abort", "chat-log"] });
});

it("preserves edited fields on conflicts and rejects invalid input without mutation", async () => {
  mutate.mockRejectedValueOnce(new Error("Revision conflict")); await render(); await manage(); await click("Edit Review"); await input("Title", "Unsaved title"); await click("Save button");
  expect(document.body.textContent).toContain("Revision conflict"); await render({ model: { ...base, revision: 5 }, error: "Revision conflict" });
  await click("Save button"); expect(mutate).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain("changed while you were editing");
  expect((document.querySelector('[aria-label="Title"]') as HTMLInputElement).value).toBe("Unsaved title");
  await click("Cancel"); await click("Add button"); await input("Title", " "); await click("Save button");
  await input("Title", "X"); await input("Icon type", "glyph"); await input("Glyph", "x".repeat(17)); await click("Save button");
  await input("Glyph", "✓"); await input("Action", "prompt"); await input("Prompt", "é".repeat(4097)); await click("Save button");
  await input("Prompt", "unsafe\ttext"); await click("Save button"); expect(mutate).toHaveBeenCalledTimes(1);
});

it("blocks writes when unavailable and preserves modal Escape/focus behavior", async () => {
  for (const status of ["unsupported", "loading", "error"] as const) {
    await render({ status, error: status === "error" ? "Storage unavailable" : null }); await manage();
    expect(button("Add button").disabled).toBe(true); expect(button("Unpin Review").disabled).toBe(true);
    if (status === "error") expect(document.body.textContent).toContain("Storage unavailable");
    await key(document.querySelector('[role="dialog"]')!, "Escape"); expect(document.activeElement).toBe(button("More Pi buttons"));
  }
  await render(); await manage(); await click("Edit Review"); await key(document.querySelector('[role="dialog"]')!, "Escape");
  expect(document.activeElement).toBe(button("Edit Review")); expect(mutate).not.toHaveBeenCalled();
});
