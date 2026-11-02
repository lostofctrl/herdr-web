/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEditor, type FileEditorProps, type FileDraft } from "./FileEditor";

const roots: Root[] = [];
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ""; });

function setup(overrides: Partial<FileEditorProps> = {}) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push(root);
  const onDraftChange = vi.fn();
  const initial: FileDraft = { content: "original", baseContent: "original", baseRevision: "r1" };
  let props: Partial<FileEditorProps> = overrides;
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return <FileEditor content="original" revision="r1" availability="available" {...props} draft={draft} onDraftChange={(value) => { onDraftChange(value); setDraft(value); }} />;
  }
  async function render(next: Partial<FileEditorProps> = {}) { props = { ...props, ...next }; await act(async () => root.render(<Harness />)); }
  function button(text: string) { const result = [...container.querySelectorAll("button")].find((item) => item.textContent === text); if (!result) throw Error(`Missing ${text}`); return result; }
  function input() { const result = container.querySelector("textarea"); if (!result) throw Error("Missing textarea"); return result; }
  async function click(text: string) { await act(async () => button(text).click()); }
  async function change(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); }); }
  return { container, render, button, input, click, change, onDraftChange };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("FileEditor", () => {
  it("is plain text read-only until editing and reports every draft edit", async () => {
    const h = setup(); await h.render({ content: "<b>text</b>" });
    expect(h.input().readOnly).toBe(true); expect(h.input().value).toBe("<b>text</b>"); expect(h.container.querySelector("b")).toBeNull();
    await h.click("Edit"); await h.change("one"); await h.change("two");
    expect(h.onDraftChange).toHaveBeenLastCalledWith({ content: "two", baseContent: "<b>text</b>", baseRevision: "r1" });
    expect(h.container.textContent).toContain("Unsaved changes"); await h.click("Read only"); expect(h.input().readOnly).toBe(true); expect(h.input().value).toBe("two");
  });
  it("saves once with the base revision and retains edits made during the save", async () => {
    const pending = deferred<{ ok: true; revision: string }>(); const onSave = vi.fn(() => pending.promise);
    const h = setup({ onSave }); await h.render(); await h.click("Edit"); await h.change("first"); await h.click("Save");
    await h.change("second");
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { h.input().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true); expect(onSave).toHaveBeenCalledTimes(1); expect(onSave).toHaveBeenCalledWith("first", "r1");
    await act(async () => pending.resolve({ ok: true, revision: "r2" }));
    expect(h.input().value).toBe("second"); expect(h.container.textContent).toContain("Unsaved changes");
    await h.click("Save"); expect(onSave).toHaveBeenLastCalledWith("second", "r2");
  });
  it("keeps text on errors and conflicts, and supports retry after an error", async () => {
    const onSave = vi.fn().mockResolvedValueOnce({ ok: false, kind: "error", message: "Disk full" }).mockResolvedValueOnce({ ok: false, kind: "conflict", message: "Revision changed" });
    const h = setup({ onSave }); await h.render(); await h.click("Edit"); await h.change("draft"); await h.click("Save");
    expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("Disk full");
    await h.click("Save"); expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("Revision changed"); expect(h.button("Save").disabled).toBe(true);
  });
  it("updates clean text but preserves dirty drafts and flags external changes", async () => {
    const h = setup({ onSave: vi.fn() }); await h.render(); await h.render({ content: "remote", revision: "r2" });
    expect(h.input().value).toBe("remote"); await h.click("Edit"); await h.change("local"); await h.render({ content: "other", revision: "r3" });
    expect(h.input().value).toBe("local"); expect(h.container.textContent).toContain("Conflict"); expect(h.button("Save").disabled).toBe(true);
  });
  it("keeps a dirty draft across deletion, disconnect and reconnect; shortcut is prevented even without a save", async () => {
    const onSave = vi.fn(); const h = setup({ onSave }); await h.render(); await h.click("Edit"); await h.change("draft");
    await h.render({ availability: "deleted" }); expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("deleted"); expect(h.button("Save").disabled).toBe(true);
    await h.render({ availability: "disconnected" }); expect(h.container.textContent).toContain("disconnected");
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }); await act(async () => { h.input().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true); expect(onSave).not.toHaveBeenCalled();
    await h.render({ availability: "available", content: "new remote", revision: "r2" }); expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("Conflict");
  });
  it("keeps a reverted edit while an earlier save is in flight", async () => {
    const pending = deferred<{ ok: true; revision: string }>(); const h = setup({ onSave: vi.fn(() => pending.promise) });
    await h.render(); await h.click("Edit"); await h.change("first"); await h.click("Save"); await h.change("original");
    await h.render({ content: "first", revision: "r2" }); expect(h.input().value).toBe("original");
    await act(async () => pending.resolve({ ok: true, revision: "r2" }));
    expect(h.input().value).toBe("original"); expect(h.container.textContent).toContain("Unsaved changes");
  });
  it("retains a draft when a save rejects and reports external changes during a save", async () => {
    const pending = deferred<{ ok: true; revision: string }>(); const h = setup({ onSave: vi.fn(() => pending.promise) });
    await h.render(); await h.click("Edit"); await h.change("local"); await h.click("Save");
    await h.render({ content: "remote", revision: "r2" }); await act(async () => pending.resolve({ ok: true, revision: "r3" }));
    expect(h.input().value).toBe("local"); expect(h.container.textContent).toContain("Conflict"); expect(h.button("Save").disabled).toBe(true);
    const h2 = setup({ onSave: vi.fn().mockRejectedValue(new Error("Offline")) }); await h2.render(); await h2.click("Edit"); await h2.change("draft"); await h2.click("Save");
    expect(h2.input().value).toBe("draft"); expect(h2.container.querySelector('[role="alert"]')?.textContent).toBe("Offline");
  });
  it("does not mistake a save echo for a conflicting external change during continued typing", async () => {
    const pending = deferred<{ ok: true; revision: string }>(); const onSave = vi.fn(() => pending.promise);
    const h = setup({ onSave }); await h.render(); await h.click("Edit"); await h.change("saved"); await h.click("Save"); await h.change("more");
    await h.render({ content: "saved", revision: "r2" }); await act(async () => pending.resolve({ ok: true, revision: "r2" }));
    expect(h.input().value).toBe("more"); expect(h.container.textContent).not.toContain("Conflict"); expect(h.button("Save").disabled).toBe(false);
  });
});
