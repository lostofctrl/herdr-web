import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCapabilities } from "../../bridge";
import type { BridgeHttpUrl } from "../../bridgeApi";
import { defaultPiSidePanelButtons, fetchPiSidePanelButtons, parsePiSidePanelButtons, PiSidePanelButtonsConflict, putPiSidePanelButtons, type PiSidePanelButtons } from "./piSidePanelButtons";

type Status = "loading" | "ready" | "unsupported" | "error" | "saving" | "conflict";
type Resource = { status: Status; state: PiSidePanelButtons | null; draft: PiSidePanelButtons | null; latest: PiSidePanelButtons | null; error: string | null };
const loading = (): Resource => ({ status: "loading", state: null, draft: null, latest: null, error: null });
const message = (error: unknown) => error instanceof Error ? error.message : "Side panel buttons request failed";

/** Pass the selected bridge's stable httpUrl, not the page origin. Mount when the panel opens. */
export function usePiSidePanelButtons(bridgeId: string, httpUrl?: BridgeHttpUrl) {
  const [resource, setResource] = useState<Resource>(loading);
  const identity = useRef({ bridgeId, httpUrl });
  const loadedIdentity = useRef({ bridgeId, httpUrl });
  const generation = useRef(0);
  const latestRequest = useRef(0);
  const busy = useRef(false);
  const canSave = useRef(false);
  const conflictLock = useRef(false);
  const conflictRevision = useRef<number | null>(null);
  if (identity.current.bridgeId !== bridgeId || identity.current.httpUrl !== httpUrl) {
    identity.current = { bridgeId, httpUrl };
    generation.current += 1;
    busy.current = false;
    canSave.current = false;
  }
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const request = ++generation.current;
    loadedIdentity.current = { bridgeId, httpUrl };
    busy.current = false;
    canSave.current = false;
    conflictLock.current = false;
    conflictRevision.current = null;
    setResource(loading());
    const current = () => generation.current === request;
    if (!httpUrl) {
      setResource({ status: "unsupported", state: defaultPiSidePanelButtons(), draft: null, latest: null, error: null });
      return () => { latestRequest.current += 1; if (current()) generation.current += 1; };
    }
    void (async () => {
      try {
        const capabilities = await fetchCapabilities(httpUrl);
        if (!current()) return;
        if (capabilities.pi_sidepanel_buttons_version !== 1) {
          const defaults = defaultPiSidePanelButtons();
          setResource({ status: "unsupported", state: defaults, draft: null, latest: null, error: null });
          return;
        }
        const state = await fetchPiSidePanelButtons(httpUrl);
        if (current()) {
          canSave.current = true;
          setResource({ status: "ready", state, draft: state, latest: null, error: null });
        }
      } catch (error) {
        if (current()) setResource({ ...loading(), status: "error", error: message(error) });
      }
    })();
    return () => { latestRequest.current += 1; if (current()) generation.current += 1; };
  }, [bridgeId, httpUrl, refreshKey]);

  const setDraft = useCallback((draft: PiSidePanelButtons) => {
    if (identity.current.bridgeId !== bridgeId || identity.current.httpUrl !== httpUrl) return;
    setResource((old) => old.status === "ready" || old.status === "conflict" ? { ...old, draft } : old);
  }, [bridgeId, httpUrl]);
  const send = useCallback(async (draft: PiSidePanelButtons, fromConflict: boolean) => {
    if (!httpUrl || identity.current.bridgeId !== bridgeId || identity.current.httpUrl !== httpUrl || loadedIdentity.current.bridgeId !== bridgeId || loadedIdentity.current.httpUrl !== httpUrl || resource.status !== (fromConflict ? "conflict" : "ready") || !canSave.current || conflictLock.current !== fromConflict || busy.current) {
      throw new Error("Side panel buttons are not available for saving");
    }
    const request = generation.current;
    busy.current = true;
    setResource((old) => ({ ...old, draft, status: "saving", error: null }));
    try {
      const state = await putPiSidePanelButtons(httpUrl, draft);
      if (generation.current !== request) throw new Error("Bridge changed during save");
      conflictLock.current = false;
      setResource({ status: "ready", state, draft: state, latest: null, error: null });
    } catch (error) {
      if (generation.current === request) {
        if (error instanceof PiSidePanelButtonsConflict) {
          conflictLock.current = true;
          conflictRevision.current = null;
          try {
            const latest = await fetchPiSidePanelButtons(httpUrl);
            if (generation.current === request) {
              conflictRevision.current = latest.revision;
              setResource((old) => ({ ...old, status: "conflict", draft, latest, error: error.message }));
            }
          } catch (latestError) {
            if (generation.current === request) setResource((old) => ({ ...old, status: "conflict", draft, latest: null, error: `Conflict; latest state unavailable: ${message(latestError)}` }));
          }
        } else {
          setResource((old) => ({ ...old, status: fromConflict ? "conflict" : "ready", draft, error: message(error) }));
        }
      }
      throw error;
    } finally {
      if (generation.current === request) busy.current = false;
    }
  }, [bridgeId, httpUrl, resource.status]);
  const save = useCallback((draft: PiSidePanelButtons) => send(draft, false), [send]);
  const saveReconciled = useCallback(async () => {
    if (resource.status !== "conflict" || !resource.draft || !resource.latest || conflictRevision.current !== resource.latest.revision) throw new Error("Latest side panel buttons are unavailable");
    await send({ ...resource.draft, revision: resource.latest.revision }, true);
  }, [resource, send]);
  const reconcile = useCallback((draft: PiSidePanelButtons) => {
    if (identity.current.bridgeId !== bridgeId || identity.current.httpUrl !== httpUrl || resource.status !== "conflict" || !resource.latest || !conflictLock.current || conflictRevision.current !== resource.latest.revision) return;
    const reconciled = parsePiSidePanelButtons({ ...draft, revision: resource.latest.revision });
    conflictLock.current = false;
    setResource((old) => {
      if (old.status !== "conflict" || !old.latest || old.latest.revision !== reconciled.revision) return old;
      return { status: "ready", state: old.latest, draft: reconciled, latest: null, error: null };
    });
  }, [bridgeId, httpUrl, resource.status, resource.latest]);
  const refresh = useCallback(() => {
    if (identity.current.bridgeId !== bridgeId || identity.current.httpUrl !== httpUrl || loadedIdentity.current.bridgeId !== bridgeId || loadedIdentity.current.httpUrl !== httpUrl) return;
    if (resource.status === "conflict" && httpUrl) {
      const request = generation.current;
      const retry = ++latestRequest.current;
      void fetchPiSidePanelButtons(httpUrl).then((latest) => {
        if (generation.current === request && latestRequest.current === retry && conflictLock.current) {
          conflictRevision.current = latest.revision;
          setResource((old) => old.status === "conflict" ? { ...old, latest, error: "Side panel buttons have changed" } : old);
        }
      }).catch((error: unknown) => {
        if (generation.current === request && latestRequest.current === retry) setResource((old) => old.status === "conflict" ? { ...old, error: `Conflict; latest state unavailable: ${message(error)}` } : old);
      });
      return;
    }
    canSave.current = false;
    setRefreshKey((key) => key + 1);
  }, [bridgeId, httpUrl, resource.status]);
  const visible = loadedIdentity.current.bridgeId === bridgeId && loadedIdentity.current.httpUrl === httpUrl ? resource : loading();
  return { ...visible, setDraft, save, saveReconciled, reconcile, refresh };
}
