/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileExplorer, type FileExplorerProps, type FileExplorerEntry } from "./FileExplorer";

const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(props: FileExplorerProps) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.push(root);
  async function render(next = props) { await act(async () => root.render(<FileExplorer {...next} />)); }
  function item(name: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find((element) => element.textContent?.includes(name)); if (!result) throw Error(`Missing ${name}`); return result; }
  async function click(element: HTMLElement) { await act(async () => element.click()); }
  async function key(element: HTMLElement, value: string) { await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); }
  return { container, root, render, item, click, key };
}
const dir = (name: string): FileExplorerEntry => ({ name, kind: "directory" });
const file = (name: string): FileExplorerEntry => ({ name, kind: "file" });

describe("FileExplorer", () => {
  it("loads directories lazily, collapses and opens nested files as root-relative paths", async () => {
    const list = vi.fn(async (path: string) => path === "." ? [dir("src"), file("top.txt")] : path === "src" ? [dir("lib")] : [file("one.ts")]);
    const onOpen = vi.fn(); const h = setup({ rootId: "one", list, onOpen }); await h.render();
    expect(list.mock.calls).toEqual([["."]]); expect(h.item("src").getAttribute("aria-expanded")).toBe("false");
    await h.click(h.item("src")); expect(list.mock.calls).toEqual([["."], ["src"]]);
    await h.click(h.item("lib")); expect(list.mock.calls).toEqual([["."], ["src"], ["src/lib"]]);
    await h.click(h.item("one.ts")); expect(onOpen).toHaveBeenCalledExactlyOnceWith("src/lib/one.ts");
    await h.click(h.item("src")); expect(h.container.textContent).not.toContain("one.ts"); expect(h.item("src").getAttribute("aria-expanded")).toBe("false");
  });
  it("exposes loading, errors and retry without interpreting file names as HTML", async () => {
    const pending = deferred<FileExplorerEntry[]>(); const list = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce([file("<img src=x>")]);
    const h = setup({ rootId: "root", list, onOpen: vi.fn() }); await h.render();
    expect(h.container.querySelector('[role="status"]')?.textContent).toContain("Loading");
    await act(async () => pending.reject(new Error("Offline"))); expect(h.container.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    await h.click([...h.container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!);
    expect(h.item("<img src=x>")).toBeTruthy(); expect(h.container.querySelector("img")).toBeNull();
  });
  it("ignores old root and unmounted requests, including late errors", async () => {
    const old = deferred<FileExplorerEntry[]>(); const current = deferred<FileExplorerEntry[]>();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); const onOpen = vi.fn();
    const h = setup({ rootId: "old", list, onOpen }); await h.render(); await h.render({ rootId: "new", list, onOpen });
    await act(async () => current.resolve([file("current")])); await act(async () => old.resolve([file("stale")]));
    expect(h.item("current")).toBeTruthy(); expect(h.container.textContent).not.toContain("stale");
    const pending = deferred<FileExplorerEntry[]>(); const h2 = setup({ rootId: "third", list: () => pending.promise, onOpen }); await h2.render();
    await act(async () => h2.root.unmount()); roots.splice(roots.indexOf(h2.root), 1); await act(async () => pending.reject(new Error("late"))); expect(h2.container.textContent).toBe("");
  });
  it("retries a failed nested listing and ignores older callback results", async () => {
    const stale = deferred<FileExplorerEntry[]>(); const fresh = deferred<FileExplorerEntry[]>();
    const oldList = vi.fn((path: string) => path === "." ? Promise.resolve([dir("src")]) : stale.promise);
    const nextList = vi.fn((path: string) => path === "." ? Promise.resolve([dir("src")]) : fresh.promise);
    const onOpen = vi.fn(); const h = setup({ rootId: "root", list: oldList, onOpen }); await h.render(); await h.click(h.item("src"));
    await h.render({ rootId: "root", list: nextList, onOpen }); await h.click(h.item("src")); await act(async () => fresh.reject(new Error("No access")));
    expect(h.container.querySelector('[role="alert"]')?.textContent).toBe("No access");
    await act(async () => stale.resolve([file("stale")])); expect(h.container.textContent).not.toContain("stale");
    nextList.mockImplementation(async (path) => path === "." ? [dir("src")] : [file("recovered")]);
    await h.click([...h.container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!);
    expect(h.item("recovered")).toBeTruthy();
  });
  it("provides an accessible keyboard tree with expansion, navigation and activation", async () => {
    const list = vi.fn(async (path: string) => path === "." ? [dir("src"), file("top")] : [file("child")]); const onOpen = vi.fn();
    const h = setup({ rootId: "root", list, onOpen }); await h.render();
    expect(h.container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Files");
    h.item("src").focus(); await h.key(h.item("src"), "ArrowRight"); expect(h.item("src").getAttribute("aria-expanded")).toBe("true");
    await h.key(h.item("src"), "ArrowRight"); expect(document.activeElement).toBe(h.item("child"));
    await h.key(h.item("child"), "ArrowDown"); expect(document.activeElement).toBe(h.item("top"));
    await h.key(h.item("top"), "Home"); expect(document.activeElement).toBe(h.item("src"));
    await h.key(h.item("src"), "ArrowDown"); await h.key(h.item("child"), "ArrowLeft"); expect(document.activeElement).toBe(h.item("src"));
    await h.key(h.item("src"), "ArrowLeft"); expect(h.item("src").getAttribute("aria-expanded")).toBe("false");
    await h.click(h.item("top")); expect(onOpen).toHaveBeenCalledWith("top");
  });
  it("opens resolved symbolic links, expands directory links, and shows unresolved links without following them", async () => {
    const list = vi.fn(async (path: string): Promise<FileExplorerEntry[]> => path === "." ? [
      { name: "file-link", kind: "symlink", resolved_kind: "file" },
      { name: "dir-link", kind: "symlink", resolved_kind: "directory" },
      { name: "dangling", kind: "symlink" },
    ] : [file("child")]);
    const onOpen = vi.fn(); const h = setup({ rootId: "root", list, onOpen }); await h.render();
    expect(h.item("file-link").querySelector(".file-explorer-name")?.textContent).toBe("file-link");
    await h.click(h.item("file-link")); expect(onOpen).toHaveBeenCalledExactlyOnceWith("file-link");
    await h.click(h.item("dir-link")); expect(list).toHaveBeenCalledWith("dir-link"); expect(h.item("dir-link").getAttribute("aria-expanded")).toBe("true");
    await h.click(h.item("child")); expect(onOpen).toHaveBeenLastCalledWith("dir-link/child");
    expect(h.item("dangling").getAttribute("aria-disabled")).toBe("true"); expect(h.item("dangling").textContent).toContain("unavailable");
    await h.click(h.item("dangling")); expect(onOpen).toHaveBeenCalledTimes(2); expect(list).toHaveBeenCalledTimes(2);
  });
  it("rejects malicious child names and preserves literal backslash, percent and suffix names", async () => {
    const list = vi.fn(async (): Promise<FileExplorerEntry[]> => [file("."), file(".."), file("bad/name"), file("back\\\\slash%2F"), file("normal [symbolic link; unavailable]")]);
    const onOpen = vi.fn(); const h = setup({ rootId: "root", list, onOpen }); await h.render();
    expect(h.container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    await h.click(h.item("back\\\\slash%2F")); expect(onOpen).toHaveBeenLastCalledWith("back\\\\slash%2F");
    await h.click(h.item("normal [symbolic link; unavailable]")); expect(onOpen).toHaveBeenLastCalledWith("normal [symbolic link; unavailable]");
  });
  it("uses only injected callbacks and discards collapsed directory responses", async () => {
    const fetch = vi.fn(); const WebSocket = vi.fn(); vi.stubGlobal("fetch", fetch); vi.stubGlobal("WebSocket", WebSocket);
    const pending = deferred<FileExplorerEntry[]>(); const list = vi.fn((path: string) => path === "." ? Promise.resolve([dir("slow")]) : pending.promise);
    const onOpen = vi.fn(); const h = setup({ rootId: "root", list, onOpen }); await h.render();
    await h.click(h.item("slow")); await h.click(h.item("slow")); await act(async () => pending.resolve([file("late")]));
    expect(h.container.textContent).not.toContain("late"); expect(fetch).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled();
  });
});
