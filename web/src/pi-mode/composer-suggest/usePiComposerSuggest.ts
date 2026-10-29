import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiBridgeApi } from "../../pi/PiBridgeContext";
import { PI_COMPOSER_FILE_DEBOUNCE_MS, PI_COMPOSER_FILE_QUERY_LIMIT, applyPiComposerSuggestion, piComposerCatalogSuggestions, piComposerFileSuggestions, piComposerTrigger, piComposerTriggerKey } from "./piComposerSuggest";
import type { PiComposerSuggestion } from "./piComposerSuggest";

export type PiComposerSuggestOptions = { api: PiBridgeApi | null; draft: string; cursor: number; enabled?: boolean };
export type PiComposerSuggestionPick = { value: string; cursor: number };
type FileResult = { key: string; files: {path:string}[]; error: string | null };

export function usePiComposerSuggest({api, draft, cursor, enabled = true}: PiComposerSuggestOptions) {
  const trigger = useMemo(() => piComposerTrigger(draft, cursor), [cursor, draft]);
  const triggerKey = piComposerTriggerKey(trigger);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [result, setResult] = useState<FileResult | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSequence = useRef(0);
  const online = api?.status === "online";
  const fileQuery = trigger?.kind === "file" ? trigger.query : null;
  const canListFiles = api?.capabilities.list_files === true;
  const available = enabled && online && trigger !== null && (trigger.kind === "slash" ? api?.catalog != null : canListFiles);
  const isOpen = available && triggerKey !== dismissedKey;
  const listFiles = api?.listFiles;
  const requestKey = JSON.stringify([api?.paneId, fileQuery]);

  useEffect(() => { if (triggerKey === null) setDismissedKey(null); }, [triggerKey]);
  useEffect(() => {
    const sequence = ++requestSequence.current;
    setResult(null);
    if (!isOpen || !listFiles || !canListFiles || fileQuery === null) return;
    const timer = window.setTimeout(() => {
      void listFiles(fileQuery, PI_COMPOSER_FILE_QUERY_LIMIT).then(files => {
        if (requestSequence.current === sequence) setResult({key: requestKey, files, error: null});
      }).catch(() => {
        if (requestSequence.current === sequence) setResult({key: requestKey, files: [], error: "File search failed. Edit the query to retry."});
      });
    }, PI_COMPOSER_FILE_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ++requestSequence.current; };
  }, [canListFiles, fileQuery, isOpen, listFiles, requestKey]);

  const catalogItems = useMemo(() => trigger?.kind === "slash" ? piComposerCatalogSuggestions(api?.catalog ?? null, trigger.query, api?.capabilities.skills_catalog === true) : [], [api?.catalog, api?.capabilities.skills_catalog, trigger]);
  const fileItems = useMemo(() => fileQuery !== null && result?.key === requestKey ? piComposerFileSuggestions(result.files, fileQuery) : [], [fileQuery, requestKey, result]);
  const items = trigger?.kind === "slash" ? catalogItems : fileItems;
  useEffect(() => { setActiveIndex(0); }, [items.length, triggerKey]);
  const moveActive = useCallback((delta: number) => {
    if (items.length) setActiveIndex(current => (current + delta + items.length) % items.length);
  }, [items.length]);
  const close = useCallback(() => { setDismissedKey(triggerKey); }, [triggerKey]);
  const reopen = useCallback(() => { setDismissedKey(null); }, []);
  const pick = useCallback((item: PiComposerSuggestion): PiComposerSuggestionPick | null => {
    if (!trigger) return null;
    const next = applyPiComposerSuggestion(draft, trigger, cursor, item.insert);
    setDismissedKey(piComposerTriggerKey(piComposerTrigger(next.value, next.cursor)));
    setResult(null);
    return next;
  }, [cursor, draft, trigger]);
  const pickActive = useCallback(() => items[activeIndex] ? pick(items[activeIndex]) : null, [activeIndex, items, pick]);
  return { trigger, isOpen, items, activeIndex, setActiveIndex, moveActive, pick, pickActive, close, reopen,
    loadingFiles: isOpen && fileQuery !== null && result?.key !== requestKey,
    error: result?.key === requestKey ? result.error : null,
    query: trigger?.query ?? "" };
}
