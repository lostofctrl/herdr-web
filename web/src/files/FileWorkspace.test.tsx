/** @vitest-environment jsdom */
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileWorkspace, type FileWorkspaceDraft, type FileWorkspaceProps } from "./FileWorkspace";
import type { FileSaveResult } from "./FileEditor";

const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(overrides: Partial<FileWorkspaceProps> = {}, initial: Record<string, FileWorkspaceDraft> = {}) {
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.push(root);
  const list = vi.fn(async () => [{ name: "a.txt", kind: "file" as const }, { name: "b.txt", kind: "file" as const }]);
  const read = vi.fn(async (path: string) => ({ content: `remote ${path}`, revision: "r1" }));
  const save = vi.fn(async (): Promise<FileSaveResult> => ({ ok: true, revision: "r2" }));
  let props: Partial<FileWorkspaceProps> = overrides; let snapshots: Record<string, FileWorkspaceDraft> = initial;
  function Harness() {
    const [drafts, setDrafts] = useState(initial); snapshots = drafts;
    return <FileWorkspace bindingKey="binding-1" list={list} read={read} save={save} drafts={drafts} onDraftChange={(path, draft) => setDrafts((old) => ({ ...old, [path]: draft }))} {...props} />;
  }
  async function render(next: Partial<FileWorkspaceProps> = {}) { props = { ...props, ...next }; await act(async () => root.render(<Harness />)); }
  function button(text: string) { const el = [...container.querySelectorAll("button")].find((b) => (b.querySelector(".file-explorer-name")?.textContent ?? b.textContent?.trim()) === text); if (!el) throw Error(`Missing button ${text}: ${container.textContent}`); return el; }
  async function click(text: string) { await act(async () => button(text).click()); }
  function input() { const el = container.querySelector("textarea"); if (!el) throw Error(`Missing textarea: ${container.textContent}`); return el; }
  function field(label: string) { const el = [...container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === label); if (!el) throw Error(`Missing input ${label}: ${container.textContent}`); return el; }
  async function type(label: string, value: string) { const el = field(label); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); }
  async function change(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new Event("input", { bubbles: true })); }); }
  return { container, render, click, button, input, change, type, field, read, save, list, drafts: () => snapshots };
}

describe("FileWorkspace", () => {
  it("previews Markdown drafts without active markup, links, or images", async () => {
    const h = setup({
      list: async () => [{ name: "note.md", kind: "file" }],
      read: async () => ({ content: "# Hello\n\n[link](https://example.test) ![pic](https://example.test/x.png) <script>alert(1)</script>", revision: "r1" }),
    });
    await h.render(); await h.click("note.md"); await h.click("Preview Markdown");
    const preview = h.container.querySelector('[aria-label="Markdown preview"]');
    expect(preview?.textContent).toContain("Hello");
    expect(preview?.querySelector("a, img, script, [href], [src]")).toBeNull();
  });

  it("retains drafts with their original base across file switches and detects a remote change", async () => {
    const h = setup(); await h.render(); await h.click("a.txt"); await h.click("Edit"); await h.change("local a"); await h.click("b.txt"); await h.click("Edit"); await h.change("local b");
    expect(h.drafts()["a.txt"]).toEqual({ content: "local a", baseContent: "remote a.txt", baseRevision: "r1" });
    h.read.mockResolvedValueOnce({ content: "external a", revision: "r2" }); await h.click("a.txt");
    expect(h.input().value).toBe("local a"); expect(h.container.textContent).toContain("Conflict"); expect(h.button("Save").disabled).toBe(true);
    await h.click("b.txt"); expect(h.input().value).toBe("local b");
  });
  it("preserves edits during an in-flight save and uses the returned revision on retry", async () => {
    const pending = deferred<FileSaveResult>(); const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true, revision: "r3" });
    const h = setup({ save }); await h.render(); await h.click("a.txt"); await h.click("Edit"); await h.change("one"); await h.click("Save"); await h.change("two");
    await act(async () => pending.resolve({ ok: true, revision: "r2" })); expect(h.input().value).toBe("two"); expect(h.drafts()["a.txt"]).toEqual({ content: "two", baseContent: "one", baseRevision: "r2" });
    await h.click("Save"); expect(save).toHaveBeenLastCalledWith("a.txt", "two", "r2");
  });
  it("ignores late reads after path and binding changes", async () => {
    const old = deferred<{ content: string; revision: string }>(); const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ content: "current", revision: "r2" });
    const h = setup({ read }); await h.render(); await h.click("a.txt"); await h.click("b.txt"); await act(async () => old.resolve({ content: "stale", revision: "r1" })); expect(h.input().value).toBe("current");
    const pending = deferred<{ content: string; revision: string }>(); read.mockReturnValueOnce(pending.promise); await h.click("a.txt"); await h.render({ bindingKey: "binding-2" }); await h.click("b.txt"); await act(async () => pending.resolve({ content: "wrong root", revision: "old" })); expect(h.input().value).toBe("current"); expect(h.container.textContent).not.toContain("wrong root");
  });
  it("ignores late saves after switching file or binding without changing newer drafts", async () => {
    const first = deferred<FileSaveResult>(); const second = deferred<FileSaveResult>(); const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = setup({ save }); await h.render(); await h.click("a.txt"); await h.click("Edit"); await h.change("first"); await h.click("Save"); await h.click("b.txt"); await h.click("a.txt"); await h.click("Edit"); await h.change("newer");
    await act(async () => first.resolve({ ok: true, revision: "r2" })); expect(h.drafts()["a.txt"]).toEqual({ content: "newer", baseContent: "remote a.txt", baseRevision: "r1" });
    await h.click("Save"); await h.render({ bindingKey: "binding-2" }); await act(async () => second.resolve({ ok: true, revision: "r3" })); expect(h.drafts()["a.txt"]).toMatchObject({ content: "newer", baseRevision: "r1" });
  });
  it("keeps persisted drafts available through deletion and offline errors, with retry and warnings", async () => {
    const saved = { content: "draft", baseContent: "old", baseRevision: "old-rev" };
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Deleted remotely"), { code: "not_found" })).mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ content: "old", revision: "old-rev" });
    const h = setup({ read, storageWarning: "Draft storage failed" }, { "a.txt": saved }); await h.render(); await h.click("a.txt");
    expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("deleted"); expect(h.container.textContent).toContain("Draft storage failed");
    await h.click("Retry read"); expect(h.input().value).toBe("draft"); expect(h.container.textContent).toContain("Offline");
    await h.click("Retry read"); expect(h.input().value).toBe("draft"); expect(h.drafts()["a.txt"]).toEqual(saved);
    expect(h.container.textContent).toContain("not supported");
  });
  it("uses resolved symlink hints without altering paths and never follows unresolved links", async () => {
    const list = vi.fn(async (path: string) => path === "." ? [
      { name: "safe", kind: "symlink" as const, resolved_kind: "file" as const },
      { name: "dir", kind: "symlink" as const, resolved_kind: "directory" as const },
      { name: "unknown", kind: "symlink" as const },
      { name: "ordinary [symbolic link; unavailable]", kind: "file" as const },
      { name: "back\\\\slash%2F", kind: "file" as const },
      { name: "..", kind: "file" as const }, { name: "evil/name", kind: "file" as const },
    ] : [{ name: "inside", kind: "file" as const }]);
    const h = setup({ list }); await h.render();
    await h.click("safe"); expect(h.read).toHaveBeenLastCalledWith("safe");
    await h.click("dir"); expect(list).toHaveBeenLastCalledWith("dir"); await h.click("inside"); expect(h.read).toHaveBeenLastCalledWith("dir/inside");
    await h.click("unknown"); expect(h.read).toHaveBeenCalledTimes(2); expect(h.button("unknown").getAttribute("aria-disabled")).toBe("true");
    await h.click("ordinary [symbolic link; unavailable]"); expect(h.read).toHaveBeenLastCalledWith("ordinary [symbolic link; unavailable]");
    await h.click("back\\\\slash%2F"); expect(h.read).toHaveBeenLastCalledWith("back\\\\slash%2F");
    expect(h.container.textContent).not.toContain("evil/name");
  });
  it("surfaces a server rejection when a resolved link target changes", async () => {
    const list = vi.fn(async () => [{ name: "link", kind: "symlink" as const, resolved_kind: "file" as const }]);
    const read = vi.fn().mockRejectedValue(new Error("Target is outside the root")); const h = setup({ list, read });
    await h.render(); await h.click("link"); expect(read).toHaveBeenCalledExactlyOnceWith("link"); expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Target is outside the root");
  });
  it("discards a link read when its binding changes", async () => {
    const pending = deferred<{ content: string; revision: string }>();
    const list = vi.fn(async () => [{ name: "link", kind: "symlink" as const, resolved_kind: "file" as const }]);
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ content: "new binding", revision: "r2" });
    const h = setup({ list, read }); await h.render(); await h.click("link"); await h.render({ bindingKey: "binding-2" }); await h.click("link");
    await act(async () => pending.resolve({ content: "stale target", revision: "r1" })); expect(h.input().value).toBe("new binding"); expect(h.container.textContent).not.toContain("stale target");
  });
  it("rejects a save response invalidated by refresh or going offline", async () => {
    const pending = deferred<FileSaveResult>(); const save = vi.fn(() => pending.promise);
    const h = setup({ save }); await h.render(); await h.click("a.txt"); await h.click("Edit"); await h.change("local"); await h.click("Save");
    await h.click("Refresh file"); await h.render({ offline: true }); await act(async () => pending.resolve({ ok: true, revision: "late" }));
    expect(h.drafts()["a.txt"]).toEqual({ content: "local", baseContent: "remote a.txt", baseRevision: "r1" }); expect(h.input().value).toBe("local"); expect(h.button("Save").disabled).toBe(true);
  });
  it("quarantines legacy drafts without guessing a base or permitting a save", async () => {
    const recovery = { content: "legacy work", needsRecovery: true as const };
    const h = setup({}, { "a.txt": recovery }); await h.render(); await h.click("a.txt");
    expect(h.input().value).toBe("legacy work"); expect(h.input().readOnly).toBe(true); expect(h.container.textContent).toContain("recovery");
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(false);
    expect(h.save).not.toHaveBeenCalled(); expect(h.drafts()["a.txt"]).toEqual(recovery);
    await h.click("b.txt"); await h.click("a.txt"); expect(h.input().value).toBe("legacy work"); expect(h.drafts()["a.txt"]).toEqual(recovery);
  });
  it("surfaces save failures and allows retry without losing the draft", async () => {
    const save = vi.fn().mockResolvedValueOnce({ ok: false, kind: "error", message: "Offline" }).mockResolvedValueOnce({ ok: true, revision: "r2" });
    const h = setup({ save }); await h.render(); await h.click("a.txt"); await h.click("Edit"); await h.change("draft"); await h.click("Save"); expect(h.container.textContent).toContain("Offline"); expect(h.input().value).toBe("draft"); await h.click("Save"); expect(save).toHaveBeenCalledTimes(2);
  });
  it("creates files and directories at the confirmed root and refreshes the listing", async () => {
    const createFile = vi.fn(async () => {}); const createDirectory = vi.fn(async () => {});
    const h = setup({ createFile, createDirectory }); await h.render(); const before = h.list.mock.calls.length;
    await h.type("New name", "new.txt"); await h.click("Create file");
    expect(createFile).toHaveBeenCalledExactlyOnceWith("new.txt"); expect(h.list.mock.calls.length).toBeGreaterThan(before);
    await h.type("New name", "folder"); await h.click("Create directory");
    expect(createDirectory).toHaveBeenCalledExactlyOnceWith("folder");
  });
  it("renames and deletes the selected file, notifying the owner to move the tab", async () => {
    const rename = vi.fn(async () => {}); const remove = vi.fn(async () => {}); const onPathRenamed = vi.fn(); const onPathRemoved = vi.fn();
    const h = setup({ rename, remove, onPathRenamed, onPathRemoved }); await h.render(); await h.click("a.txt");
    await h.click("Rename"); await h.type("New name", "renamed.txt"); await h.click("Confirm rename");
    expect(rename).toHaveBeenCalledExactlyOnceWith("a.txt", "renamed.txt"); expect(onPathRenamed).toHaveBeenCalledExactlyOnceWith("a.txt", "renamed.txt");
    await h.click("b.txt"); await h.click("Delete"); expect(remove).not.toHaveBeenCalled();
    await h.click("Confirm delete"); expect(remove).toHaveBeenCalledExactlyOnceWith("b.txt", false); expect(onPathRemoved).toHaveBeenCalledExactlyOnceWith("b.txt");
  });
  it("surfaces operation failures and keeps the current selection usable", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const h = setup({ remove }); await h.render(); await h.click("a.txt"); await h.click("Delete"); await h.click("Confirm delete");
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Permission denied"); expect(h.input().value).toBe("remote a.txt");
  });
  it("hides operations the owner did not enable", async () => {
    const h = setup(); await h.render(); await h.click("a.txt");
    expect([...h.container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Delete");
    expect(h.container.textContent).not.toContain("Create file");
  });
});

describe("FileWorkspace transfer of file content", () => {
  it("downloads the open file and uploads a chosen file into the root", async () => {
    const download = vi.fn(async () => new Blob(["bytes"]));
    const upload = vi.fn(async () => {});
    const createObjectURL = vi.fn(() => "blob:local");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const h = setup({ download, upload });
    await h.render(); await h.click("a.txt");
    await h.click("Download file");
    expect(download).toHaveBeenCalledExactlyOnceWith("a.txt");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const input = [...h.container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Upload file")!;
    const file = new File(["payload"], "picked.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(upload).toHaveBeenCalledExactlyOnceWith("picked.txt", file);
  });
});

describe("FileWorkspace copy of the open file", () => {
  it("copies the open file to a new name and refreshes the tree", async () => {
    const copy = vi.fn(async () => {});
    const h = setup({ copy });
    await h.render(); await h.click("a.txt");
    await h.click("Copy file");
    await h.type("Copy destination", "copy.txt");
    await h.click("Confirm copy");
    expect(copy).toHaveBeenCalledExactlyOnceWith("a.txt", "copy.txt");
    expect(h.list.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("FileWorkspace directory entries", () => {
  it("copies a directory from the explorer and deletes it recursively", async () => {
    const copy = vi.fn(async () => {}); const remove = vi.fn(async () => {});
    const h = setup({
      copy, remove,
      list: async (path: string) => path === "dir" ? [{ name: "inner.txt", kind: "file" as const }] : [{ name: "dir", kind: "directory" as const }],
    });
    await h.render(); await h.click("dir");
    expect(h.container.textContent).toContain("Directory: dir");
    await h.click("Copy directory");
    await h.type("Copy destination", "copied");
    await h.click("Confirm copy");
    expect(copy).toHaveBeenCalledExactlyOnceWith("dir", "copied");
    await h.click("Delete directory");
    await h.click("Confirm delete");
    expect(remove).toHaveBeenCalledExactlyOnceWith("dir", true);
  });
});

describe("FileWorkspace external change hints", () => {
  it("reloads a clean file when the bridge reports a change", async () => {
    let notify: ((event: { kind: "change"; name: string }) => void) | null = null;
    const read = vi.fn(async (path: string) => ({ content: `remote ${path}`, revision: "r1" }));
    const h = setup({ read, watch: (_path, onEvent) => { notify = onEvent as typeof notify; return () => {}; } });
    await h.render(); await h.click("a.txt");
    const before = read.mock.calls.length;
    await act(async () => { notify?.({ kind: "change", name: "a.txt" }); });
    expect(read.mock.calls.length).toBeGreaterThan(before);
    expect(h.container.textContent).toContain("Reloaded after an external change.");
  });

  it("keeps the draft and its original revision when changes were dropped", async () => {
    let notify: ((event: { kind: "overflow" }) => void) | null = null;
    const read = vi.fn(async (path: string) => ({ content: `remote ${path}`, revision: "r1" }));
    const save = vi.fn(async () => ({ ok: true as const, revision: "r2" }));
    const h = setup({ read, save, watch: (_path, onEvent) => { notify = onEvent as typeof notify; return () => {}; } });
    await h.render(); await h.click("a.txt");
    await h.change("draft survives overflow");
    const reads = read.mock.calls.length;
    await act(async () => { notify?.({ kind: "overflow" }); });
    expect(read.mock.calls.length).toBe(reads);
    expect(h.input().value).toBe("draft survives overflow");
    await h.click("Save");
    // The draft still saves against the revision it was loaded at, so the bridge
    // - not the browser - decides whether the dropped change is a conflict.
    expect(save).toHaveBeenCalledExactlyOnceWith("a.txt", "draft survives overflow", "r1");
  });

  it("keeps an unsaved draft and its save base when the file changes on disk", async () => {
    let notify: ((event: { kind: "change"; name: string }) => void) | null = null;
    const read = vi.fn(async (path: string) => ({ content: `remote ${path}`, revision: "r1" }));
    const h = setup({ read, watch: (_path, onEvent) => { notify = onEvent as typeof notify; return () => {}; } });
    await h.render(); await h.click("a.txt");
    await h.change("local edit");
    const before = read.mock.calls.length;
    await act(async () => { notify?.({ kind: "change", name: "a.txt" }); });
    expect(read.mock.calls.length).toBe(before);
    expect(h.input().value).toBe("local edit");
    expect(h.container.textContent).toContain("This file changed on disk.");
  });
});

describe("FileWorkspace search", () => {
  it("searches names or contents and opens a hit", async () => {
    const search = vi.fn(async (query: string, content: boolean) => content
      ? [{ path: "dir/b.txt", line: 3 }]
      : [{ path: "dir/a.txt" }]);
    const h = setup({ search });
    await h.render();
    await h.type("Search files", "a");
    await h.click("Search");
    expect(search).toHaveBeenCalledWith("a", false);
    expect(h.container.textContent).toContain("dir/a.txt");
    await act(async () => { h.container.querySelector<HTMLInputElement>('input[aria-label="Search file contents"]')!.click(); });
    await h.click("Search");
    expect(search).toHaveBeenLastCalledWith("a", true);
    await h.click("dir/b.txt:3");
    expect(h.input().value).toBe("remote dir/b.txt");
  });
});

describe("FileWorkspace Pi mentions", () => {
  it("inserts an absolute path and line into the chosen Pi pane without submitting", async () => {
    const insert = vi.fn(async () => null);
    const h = setup({ mention: { targets: [{ paneId: "p1", label: "π pane one" }, { paneId: "p2", label: "π pane two" }], insert } });
    await h.render(); await h.click("a.txt");
    const select = h.container.querySelector<HTMLSelectElement>('select[aria-label="Pi pane"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "p2"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await h.type("Line number", "12");
    await h.click("Mention in Pi");
    expect(insert).toHaveBeenCalledExactlyOnceWith({ paneId: "p2", label: "π pane two" }, "a.txt", 12);
    expect(h.container.querySelector('[role="status"]')?.textContent).toContain("π pane two");
  });
  it("rejects an invalid line number and surfaces insertion failures", async () => {
    const insert = vi.fn(async () => "That Pi pane is no longer available");
    const h = setup({ mention: { targets: [{ paneId: "p1", label: "π one" }], insert } });
    await h.render(); await h.click("a.txt");
    await h.type("Line number", "0");
    await h.click("Mention in Pi");
    expect(insert).not.toHaveBeenCalled();
    await h.type("Line number", "3");
    await h.click("Mention in Pi");
    expect(h.container.querySelector('[role="status"]')?.textContent).toContain("no longer available");
  });
});

describe("FileWorkspace under StrictMode", () => {
  it("still completes file operations after the development double effect", async () => {
    const rename = vi.fn(async () => {}); const onPathRenamed = vi.fn();
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.push(root);
    const list = async () => [{ name: "a.txt", kind: "file" as const }];
    const read = async (path: string) => ({ content: `remote ${path}`, revision: "r1" });
    const save = async (): Promise<FileSaveResult> => ({ ok: true, revision: "r2" });
    const button = (text: string) => { const el = [...container.querySelectorAll("button")].find((b) => (b.querySelector(".file-explorer-name")?.textContent ?? b.textContent?.trim()) === text); if (!el) throw Error(`Missing button ${text}: ${container.textContent}`); return el; };
    await act(async () => root.render(<StrictMode><FileWorkspace bindingKey="b" list={list} read={read} save={save} drafts={{}} onDraftChange={() => {}} rename={rename} onPathRenamed={onPathRenamed} /></StrictMode>));
    await act(async () => button("a.txt").click());
    await act(async () => button("Rename").click());
    const input = [...container.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "New name")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "b.txt"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("Confirm rename").click());
    expect(rename).toHaveBeenCalledExactlyOnceWith("a.txt", "b.txt");
    expect(onPathRenamed).toHaveBeenCalledExactlyOnceWith("a.txt", "b.txt");
  });
});

describe("FileWorkspace rename of the open file", () => {
  it("clears the stale editor so a saved draft cannot target the old path", async () => {
    const rename = vi.fn(async () => {}); const onPathRenamed = vi.fn();
    const h = setup({ rename, onPathRenamed }); await h.render(); await h.click("a.txt");
    await h.click("Rename"); await h.type("New name", "renamed.txt"); await h.click("Confirm rename");
    expect(h.container.textContent).toContain("Select a file to view or edit.");
  });
});
