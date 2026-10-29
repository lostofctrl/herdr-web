/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PiBridgeApi } from "../../pi/PiBridgeContext";
import { usePiComposerSuggest } from "./usePiComposerSuggest";

let current: ReturnType<typeof usePiComposerSuggest>;
let root: ReturnType<typeof createRoot>;
function Harness(props: Parameters<typeof usePiComposerSuggest>[0]) { current = usePiComposerSuggest(props); return null; }
afterEach(async () => { if(root) await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("debounces file queries and ignores a stale reply that lands after a newer one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const pending: ((files: {path:string}[])=>void)[] = [];
  const listFiles = vi.fn(() => new Promise<{path:string}[]>(resolve => pending.push(resolve)));
  const api = {paneId:"a", status:"online",capabilities:{list_files:true},listFiles} as unknown as PiBridgeApi;
  root = createRoot(document.createElement("div"));
  const render = async (draft: string, nextApi = api, enabled = true) => act(async () => root.render(<Harness api={nextApi} draft={draft} cursor={draft.length} enabled={enabled}/>));
  await render("@a");
  expect(current!.loadingFiles).toBe(true);
  await act(async () => vi.advanceTimersByTime(199));
  expect(listFiles).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(listFiles).toHaveBeenLastCalledWith("a",50);
  // Reopening the same query issues a second request for the same result key, so
  // only the sequence guard decides which reply wins.
  await render("@a ");
  await render("@a");
  await act(async () => vi.advanceTimersByTime(200));
  expect(listFiles).toHaveBeenCalledTimes(2);
  await act(async () => pending[1]([{path:"a-new.ts"}]));
  expect(current!.items.map(item => item.label)).toEqual(["a-new.ts"]);
  expect(current!.loadingFiles).toBe(false);
  // The superseded request answers afterwards; it must not replace the newer reply.
  await act(async () => pending[0]([{path:"a-old.ts"}]));
  expect(current!.items.map(item => item.label)).toEqual(["a-new.ts"]);
  expect(current!.error).toBeNull();
});
it("keeps a newer success when an older query rejects late and closes when disconnected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const pending: {resolve:(files:{path:string}[])=>void; reject:(error:Error)=>void}[] = [];
  const listFiles = vi.fn(() => new Promise<{path:string}[]>((resolve, reject) => pending.push({resolve, reject})));
  const api = {paneId:"a", status:"online",capabilities:{list_files:true},listFiles} as unknown as PiBridgeApi;
  root = createRoot(document.createElement("div"));
  const render = async (draft: string, nextApi = api, enabled = true) => act(async () => root.render(<Harness api={nextApi} draft={draft} cursor={draft.length} enabled={enabled}/>));
  await render("@a");
  await act(async () => vi.advanceTimersByTime(200));
  await render("@b");
  await act(async () => vi.advanceTimersByTime(200));
  await act(async () => pending[1].resolve([{path:"b.ts"}]));
  expect(current!.items.map(item => item.label)).toEqual(["b.ts"]);
  // A late rejection from the superseded query cannot raise an error over it.
  await act(async () => pending[0].reject(new Error("failed")));
  expect(current!.error).toBeNull();
  expect(current!.items.map(item => item.label)).toEqual(["b.ts"]);
  // Disconnecting closes the popup over pending work.
  await render("@b", {...api,status:"offline"});
  await act(async () => pending[1].resolve([{path:"b.ts"}]));
  expect(current!.isOpen).toBe(false);
});
it("surfaces a failure of the current query and stays closed when disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const api = {paneId:"a", status:"online",capabilities:{list_files:true},listFiles:vi.fn().mockRejectedValue(new Error("failed"))} as unknown as PiBridgeApi;
  root = createRoot(document.createElement("div"));
  const render = async (draft: string, nextApi = api, enabled = true) => act(async () => root.render(<Harness api={nextApi} draft={draft} cursor={draft.length} enabled={enabled}/>));
  await render("@b");
  await act(async () => vi.advanceTimersByTime(200));
  expect(current!.error).toContain("File search failed");
  expect(current!.loadingFiles).toBe(false);
  await render("@b",api,false);
  expect(current!.isOpen).toBe(false);
});
it("honors the skills capability and dismisses a query", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  const api = {paneId:"a",status:"online", capabilities:{skills_catalog:false},catalog:{commands:[],skills:[{name:"tdd",description:"test first",source:"skill"}]}} as unknown as PiBridgeApi;
  await act(async () => root.render(<Harness api={api} draft="/" cursor={1}/>));
  expect(current!.items).toEqual([]);
  await act(async () => root.render(<Harness api={{...api,capabilities:{skills_catalog:true}}} draft="/" cursor={1}/>));
  expect(current!.items[0].insert).toBe("/skill:tdd");
  await act(async () => current!.close());
  expect(current!.isOpen).toBe(false);
});
