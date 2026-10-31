// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPiSidePanelButtons } from "./piSidePanelButtons";
import { usePiSidePanelButtons } from "./usePiSidePanelButtons";

let current: ReturnType<typeof usePiSidePanelButtons>;
const one = (path: string) => `https://one/proxy${path}`;
const two = (path: string) => `https://two${path}`;
function Probe({ bridgeId, httpUrl }: { bridgeId: string; httpUrl?: typeof one }) {
  current = usePiSidePanelButtons(bridgeId, httpUrl);
  return null;
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const state = defaultPiSidePanelButtons();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("returns read-only defaults without a URL and never fetches", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  await act(async () => root.render(<Probe bridgeId="one" />));
  expect(current.status).toBe("unsupported"); expect(current.state).toEqual(state);
  await act(async () => { await expect(current.save(state)).rejects.toThrow(); });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows defaults read-only when unsupported and errors when offline", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ commands: [] })).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  expect(current.status).toBe("unsupported"); expect(current.state).toEqual(state);
  await act(async () => { await expect(current.save(state)).rejects.toThrow(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Probe bridgeId="two" httpUrl={two} />));
  expect(current.status).toBe("error"); expect(current.error).toContain("offline");
  await act(async () => { await expect(current.save(state)).rejects.toThrow(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("ignores stale responses on bridge switch and refreshes on remount", async () => {
  let finish!: (value: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    if (String(url).startsWith("https://one")) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(String(url).endsWith("capabilities") ? response({ pi_sidepanel_buttons_version: 1 }) : response({ ...state, revision: 7 }));
  });
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  await act(async () => root.render(<Probe bridgeId="two" httpUrl={two} />));
  expect(current.state?.revision).toBe(7);
  await act(async () => { finish(response({ pi_sidepanel_buttons_version: 1 })); });
  expect(current.state?.revision).toBe(7);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("https://one/proxy/api/pi-sidepanel-buttons");
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<Probe bridgeId="two" httpUrl={two} />));
  expect(fetchMock.mock.calls.filter(([url]) => String(url) === "https://two/api/capabilities")).toHaveLength(2);
});

it("preserves the draft and exposes the latest state after a conflict", async () => {
  const latest = { ...state, revision: 2, pinned: ["abort"] };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ pi_sidepanel_buttons_version: 1 }))
    .mockResolvedValueOnce(response(state))
    .mockResolvedValueOnce(response({ error: "conflict" }, 409))
    .mockResolvedValueOnce(response(latest));
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  const draft = { ...state, pinned: ["compact"] };
  const staleSave = current.save;
  await act(async () => { await expect(current.save(draft)).rejects.toThrow("Side panel buttons have changed"); });
  await act(async () => { await expect(staleSave({ ...draft, revision: latest.revision })).rejects.toThrow(); });
  expect(current.status).toBe("conflict"); expect(current.draft).toEqual(draft); expect(current.latest).toEqual(latest);
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(draft);
  expect(fetchMock.mock.calls[3][0]).toBe("https://one/proxy/api/pi-sidepanel-buttons");
  await act(async () => current.reconcile(draft));
  expect(current.status).toBe("ready");
  expect(current.draft).toEqual({ ...draft, revision: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("keeps a conflict draft when fetching the latest version fails and retries without writing", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ pi_sidepanel_buttons_version: 1 }))
    .mockResolvedValueOnce(response(state))
    .mockResolvedValueOnce(response({}, 409))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response({ ...state, revision: 3 }));
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  const draft = { ...state, pinned: ["resume"] };
  await act(async () => { await expect(current.save(draft)).rejects.toThrow("Side panel buttons have changed"); });
  expect(current.status).toBe("conflict"); expect(current.draft).toEqual(draft);
  expect(current.latest).toBeNull(); expect(current.error).toContain("offline");
  await act(async () => current.refresh());
  expect(current.draft).toEqual(draft); expect(current.latest?.revision).toBe(3);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

it("explicitly saves the preserved draft at the latest revision and handles repeat conflicts", async () => {
  const latest = { ...state, revision: 2 };
  const newer = { ...state, revision: 3 };
  const draft = { ...state, pinned: ["compact"] };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ pi_sidepanel_buttons_version: 1 }))
    .mockResolvedValueOnce(response(state))
    .mockResolvedValueOnce(response({}, 409))
    .mockResolvedValueOnce(response(latest))
    .mockResolvedValueOnce(response({}, 409))
    .mockResolvedValueOnce(response(newer))
    .mockResolvedValueOnce(response({ ...draft, revision: 4 }));
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  await act(async () => { await expect(current.save(draft)).rejects.toThrow(); });
  await act(async () => { await expect(current.saveReconciled()).rejects.toThrow(); });
  expect(current.draft).toEqual({ ...draft, revision: 2 });
  expect(current.latest).toEqual(newer);
  await act(async () => { await current.saveReconciled(); });
  expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toEqual({ ...draft, revision: 2 });
  expect(JSON.parse(String(fetchMock.mock.calls[6][1]?.body))).toEqual({ ...draft, revision: 3 });
  expect(current.status).toBe("ready"); expect(current.state?.revision).toBe(4);
});

it("rejects failed saves while preserving the supplied candidate", async () => {
  const draft = { ...state, pinned: ["resume"] };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response({ pi_sidepanel_buttons_version: 1 }))
    .mockResolvedValueOnce(response(state))
    .mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  await act(async () => { await expect(current.save(draft)).rejects.toThrow("offline"); });
  expect(current.draft).toEqual(draft); expect(current.error).toContain("offline");
});

it("rejects a save that completes after switching bridges without updating the new bridge", async () => {
  let finish!: (value: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (init?.method === "PUT") return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(String(url).endsWith("capabilities") ? response({ pi_sidepanel_buttons_version: 1 }) : response({ ...state, revision: String(url).startsWith("https://two") ? 9 : 0 }));
  });
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  let saving!: Promise<void>;
  await act(async () => { saving = current.save(state); });
  await act(async () => root.render(<Probe bridgeId="two" httpUrl={two} />));
  await act(async () => { finish(response({ ...state, revision: 1 })); await expect(saving).rejects.toThrow("Bridge changed"); });
  expect(current.state?.revision).toBe(9);
});

it("ignores a pending state response and an old save callback after switching bridges", async () => {
  let finish!: (value: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    if (String(url) === "https://one/proxy/api/pi-sidepanel-buttons") return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(String(url).endsWith("capabilities") ? response({ pi_sidepanel_buttons_version: 1 }) : response({ ...state, revision: 9 }));
  });
  await act(async () => root.render(<Probe bridgeId="one" httpUrl={one} />));
  const oldSave = current.save;
  await act(async () => root.render(<Probe bridgeId="two" httpUrl={two} />));
  await act(async () => { finish(response(state)); await expect(oldSave(state)).rejects.toThrow(); });
  expect(current.state?.revision).toBe(9);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});
