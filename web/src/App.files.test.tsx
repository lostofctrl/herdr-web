/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileShellNavigation } from "./App";
import type { BridgeConnectionView } from "./App";
import type { BridgeRuntime } from "./bridge";

const roots: Root[] = [];
const commands = vi.fn();
const selection = vi.fn();
const runtime = (overrides: Partial<BridgeRuntime> = {}): BridgeRuntime => ({
  id: "a", mode: "configured", label: "Host A", color: "#ffffff", backend: null,
  connectionKey: "url-a", resumeToken: 0, capabilityState: "ready", capabilityError: null,
  canConnect: true, capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-a" } },
  httpUrl: (path) => path, wsUrl: (path) => path, ...overrides,
});
const view = (r: BridgeRuntime): BridgeConnectionView => ({ runtime: r, loadState: "ready", snapshot: {} as BridgeConnectionView["snapshot"] });
let container: HTMLDivElement;
let root: Root;
function render(r = runtime(), views = [view(r)]) {
  return act(async () => root.render(<FileShellNavigation selectedRuntime={r} bridgeViews={views}>
    {({ active, showTerminal }) => <><button onClick={() => { showTerminal(); commands(); selection(); }}>Herdr tab</button><span>{active ? "File active" : "Terminal active"}</span></>}
  </FileShellNavigation>));
}
function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent === label || item.querySelector(".file-explorer-name")?.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); commands.mockClear(); selection.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); roots.push(root);
});
afterEach(async () => { await act(async () => { for (const item of roots.splice(0)) item.unmount(); }); document.body.innerHTML = ""; });

describe("browser-local file navigation", () => {
  it("opens files through the owning bridge and retains unsaved edits while switching tabs", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { identity: object; operation: { type: string } };
      const result = request.operation.type === "list" ? { entries: [{ name: "a.txt", kind: "file" }] } : { content: "original", revision: "r1" };
      return { ok: true, status: 200, json: async () => ({ identity: request.identity, result }) };
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const a = runtime({ httpUrl: (path) => `https://host-a.example/proxy${path}` });
      await render(a); await click("New file tab"); await click("a.txt"); await click("Edit");
      const input = container.querySelector("textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "private draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await click("Herdr tab"); await click("File tab 1"); await click("a.txt");
      expect(container.querySelector("textarea")?.value).toBe("private draft");
      expect(fetcher).toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => url === "https://host-a.example/proxy/api/files")).toBe(true);
      expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs[0].draft).toBe("private draft");
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps late reads from one bridge from replacing another bridge's file", async () => {
    let finishRead!: (value: object) => void;
    const pending = new Promise<object>((resolve) => { finishRead = resolve; });
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { identity: object; operation: { type: string } };
      const result = request.operation.type === "list" ? { entries: [{ name: url.includes("host-a") ? "a.txt" : "b.txt", kind: "file" }] }
        : url.includes("host-a") ? await pending : { content: "bridge B", revision: "rb" };
      return { ok: true, status: 200, json: async () => ({ identity: request.identity, result }) };
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const a = runtime({ httpUrl: (path) => `https://host-a.example${path}` });
      const b = runtime({ id: "b", connectionKey: "url-b", label: "Host B", httpUrl: (path) => `https://host-b.example${path}`,
        capabilities: { commands: [], files: { version: 1, bridge_id: "host-b", root_id: "root-b", binding_id: "live-b" } } });
      await render(a, [view(a), view(b)]); await click("New file tab"); await click("a.txt");
      await render(b, [view(a), view(b)]); await click("New file tab"); await click("b.txt");
      expect(container.querySelector("textarea")?.value).toBe("bridge B");
      await act(async () => { finishRead({ content: "late bridge A", revision: "ra" }); await pending; });
      expect(container.querySelector("textarea")?.value).toBe("bridge B");
      expect(fetcher.mock.calls.some(([url]) => url === "https://host-a.example/api/files")).toBe(true);
      expect(fetcher.mock.calls.some(([url]) => url === "https://host-b.example/api/files")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps an in-memory draft and warns on reload if browser storage is full", async () => {
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "herdr.files.tabs.v1") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return original.call(this, key, value);
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { identity: object; operation: { type: string } };
      return { ok: true, status: 200, json: async () => ({ identity: request.identity, result: request.operation.type === "list" ? { entries: [{ name: "a.txt", kind: "file" }] } : { content: "original", revision: "r1" } }) };
    }));
    try {
      const a = runtime({ httpUrl: (path) => `https://host-a.example/proxy${path}` });
      await render(a); await click("New file tab"); await click("a.txt"); await click("Edit");
      const input = container.querySelector("textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "not persisted"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      expect(container.textContent).toContain("unsaved edits remain in memory only");
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await click("Herdr tab"); await click("File tab 1"); await click("a.txt");
      expect(container.querySelector("textarea")?.value).toBe("not persisted");
    } finally { storage.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("quarantines drafts from a previous binding even when opening a new shell", async () => {
    const binding = { bridgeId: "a", connectionKey: "url-a", bridgeIdentity: "host-a", rootIdentity: "root-a", bindingIdentity: "live-a" };
    localStorage.setItem("herdr.files.tabs.v1", JSON.stringify({ version: 1, tabs: [{ binding, path: "a.txt", draft: "old draft", dirty: true, baseContent: "old", baseRevision: "r1" }] }));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    try {
      const restarted = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-b" } } });
      await render(restarted); await click("New file tab");
      expect(container.textContent).toContain("Root confirmation required after bridge restart");
      expect(fetcher).not.toHaveBeenCalled();
      await click("Confirm current root");
      expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs[0].binding.bindingIdentity).toBe("live-b");
    } finally { vi.unstubAllGlobals(); }
  });

  it("offers explicit discard for a draft even if its file is no longer listed", async () => {
    const binding = { bridgeId: "a", connectionKey: "url-a", bridgeIdentity: "host-a", rootIdentity: "root-a", bindingIdentity: "live-a" };
    localStorage.setItem("herdr.files.tabs.v1", JSON.stringify({ version: 1, tabs: [{ binding, path: "deleted.txt", draft: "private", dirty: true, baseContent: "old", baseRevision: "r1" }] }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      await render(); await click("New file tab");
      expect((container.querySelector('[aria-label="Draft for deleted.txt"]') as HTMLTextAreaElement | null)?.value).toBe("private");
      await click("Discard draft deleted.txt");
      expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs).toHaveLength(1);
      await click("Discard draft deleted.txt");
      expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs).toHaveLength(0);
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally { confirm.mockRestore(); }
  });

  it("warns before closing a tab with an unsaved draft without discarding it", async () => {
    const binding = { bridgeId: "a", connectionKey: "url-a", bridgeIdentity: "host-a", rootIdentity: "root-a", bindingIdentity: "live-a" };
    const draft = { binding, path: "a.txt", draft: "private draft", dirty: true, baseContent: "original", baseRevision: "r1" };
    localStorage.setItem("herdr.files.tabs.v1", JSON.stringify({ version: 1, tabs: [draft] }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      await render(); await click("New file tab"); await click("Close file tab 1");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[aria-label="File tab 1"]')).not.toBeNull();
      await click("Close file tab 1");
      expect(container.querySelector('[aria-label="File tab 1"]')).toBeNull();
      expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs).toEqual([draft]);
    } finally { confirm.mockRestore(); }
  });

  it("warns on reload when a recoverable unsaved draft exists", async () => {
    const binding = { bridgeId: "a", connectionKey: "url-a", bridgeIdentity: "host-a", rootIdentity: "root-a", bindingIdentity: "live-a" };
    localStorage.setItem("herdr.files.tabs.v1", JSON.stringify({ version: 1, tabs: [{ binding, path: "a.txt", draft: "draft", dirty: true, baseContent: "old", baseRevision: "r1" }] }));
    await render();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    localStorage.removeItem("herdr.files.tabs.v1");
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    // Removing persisted data must not suppress the warning while the in-memory draft remains.
    expect(cleanEvent.defaultPrevented).toBe(true);
  });

  it("creates, selects, closes and restores independent shells without Herdr commands", async () => {
    await render(); await click("New file tab"); await click("New file tab");
    expect(container.textContent).toContain("File active");
    expect(container.textContent).toContain("Select a file to view or edit.");
    expect(container.querySelectorAll('[role="tab"][aria-label^="File tab"]').length).toBe(2);
    await click("File tab 1"); await click("Close file tab 1");
    expect(commands).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
    await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1);
    root = createRoot(container); roots.push(root); await render();
    expect(container.querySelectorAll('[role="tab"][aria-label^="File tab"]').length).toBe(1);
    expect(container.textContent).toContain("Terminal active");
    await click("File tab 1");
    expect(container.textContent).toContain("File active");
    expect(commands).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
  });

  it("retains binding quarantine across restart and rejects identity and root mismatch", async () => {
    await render(); await click("New file tab");
    const restarted = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-b" } } });
    await render(restarted); expect(container.textContent).toContain("Confirm current root");
    const changed = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-b", root_id: "root-b", binding_id: "live-b" } } });
    await render(changed); expect(container.textContent).toContain("Bridge identity mismatch");
    expect(container.textContent).not.toContain("Confirm current root");
    const rootChanged = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-b", binding_id: "live-b" } } });
    await render(rootChanged); expect(container.textContent).toContain("Root mismatch");
    expect(container.textContent).not.toContain("Confirm current root");
    const urlChanged = runtime({ connectionKey: "url-changed" });
    await render(urlChanged); expect(container.textContent).toContain("Bridge connection mismatch");
    expect(container.textContent).not.toContain("Confirm current root");
    await render(restarted); await click("Confirm current root");
    expect(container.textContent).toContain("Select a file to view or edit.");
    expect(commands).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
  });

  it("does not offer root confirmation while the owner's live snapshot is unavailable", async () => {
    const first = runtime();
    await render(first); await click("New file tab");
    const restarted = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-b" } } });
    await render(restarted, [{ ...view(restarted), loadState: "loading", snapshot: null }]);
    expect(container.textContent).not.toContain("Confirm current root");
    await render(restarted, [{ ...view(restarted), snapshot: null }]);
    expect(container.textContent).not.toContain("Confirm current root");
    await render(restarted);
    expect(container.textContent).toContain("Confirm current root");
  });

  it("keeps shells pinned to the owner when the selected host changes or goes offline", async () => {
    const a = runtime(); await render(a); await click("New file tab");
    const b = runtime({ id: "b", label: "Host B", connectionKey: "url-b" });
    await render(b, [view(a), view(b)]); expect(container.textContent).toContain("Host A");
    await render(b, [view(b)]); expect(container.textContent).toContain("unavailable");
    await render(b, [{ ...view(a), loadState: "error" }, view(b)]); expect(container.textContent).toContain("offline");
    const oldBridge = runtime({ capabilities: { commands: [] } });
    await render(b, [view(oldBridge), view(b)]); expect(container.textContent).toContain("File service unavailable");
    expect(commands).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
  });

  it("restores the active shell and only rebinds matching stored drafts after confirmation", async () => {
    const binding = { bridgeId: "a", connectionKey: "url-a", bridgeIdentity: "host-a", rootIdentity: "root-a", bindingIdentity: "live-a" };
    const other = { binding: { ...binding, rootIdentity: "other" }, path: "other.txt", draft: "other draft", dirty: true, baseContent: "other base", baseRevision: "other-rev" };
    const draft = { binding, path: "a.txt", draft: "unsaved", dirty: true, baseContent: "base", baseRevision: "r1" };
    const legacy = { binding, path: "legacy.txt", draft: "legacy draft", dirty: true };
    localStorage.setItem("herdr.files.tabs.v1", JSON.stringify({ version: 1, tabs: [other, draft, legacy] }));
    await render(); await click("New file tab");
    await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1);
    root = createRoot(container); roots.push(root); await render();
    expect(container.textContent).toContain("File active");
    const restarted = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-b" } } });
    await render(restarted);
    expect(JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs).toContainEqual(draft);
    await click("Confirm current root");
    const saved = JSON.parse(localStorage.getItem("herdr.files.tabs.v1")!).tabs;
    expect(saved).toEqual([other, { ...draft, binding: { ...binding, bindingIdentity: "live-b" } }, { ...legacy, binding: { ...binding, bindingIdentity: "live-b" }, needsRecovery: true }]);
    expect(commands).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
  });

  it("does not overwrite unreadable shell or draft storage", async () => {
    localStorage.setItem("herdr.files.shells.v1", "broken");
    await render(); await click("New file tab");
    expect(container.textContent).toContain("saved data was not overwritten");
    expect(localStorage.getItem("herdr.files.shells.v1")).toBe("broken");
    localStorage.setItem("herdr.files.tabs.v1", "broken");
    const restarted = runtime({ capabilities: { commands: [], files: { version: 1, bridge_id: "host-a", root_id: "root-a", binding_id: "live-b" } } });
    await render(restarted); await click("Confirm current root");
    expect(container.textContent).toContain("root confirmation was not applied");
    expect(localStorage.getItem("herdr.files.tabs.v1")).toBe("broken");
  });
});
