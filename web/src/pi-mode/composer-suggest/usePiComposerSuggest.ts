import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PiBridgeApi } from "../../pi/PiBridgeContext";
import {
  PI_COMPOSER_FILE_DEBOUNCE_MS,
  PI_COMPOSER_FILE_QUERY_LIMIT,
  applyPiComposerSuggestion,
  piComposerCatalogSuggestions,
  piComposerFileSuggestions,
  piComposerTrigger,
  piComposerTriggerKey,
} from "./piComposerSuggest";
import type { PiComposerSuggestion } from "./piComposerSuggest";

export type PiComposerSuggestOptions = {
  api: PiBridgeApi | null;
  draft: string;
  cursor: number;
};

export type PiComposerSuggestionPick = { value: string; cursor: number };

/**
 * Owns the Composer suggestion popup: trigger detection, catalog/file rows,
 * the 200 ms file debounce and keyboard selection. The Composer still owns the
 * draft; `pick` returns the replacement so it can keep persistence unchanged.
 */
export function usePiComposerSuggest({
  api,
  draft,
  cursor,
}: PiComposerSuggestOptions) {
  const trigger = useMemo(() => piComposerTrigger(draft, cursor), [cursor, draft]);
  const triggerKey = piComposerTriggerKey(trigger);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string }[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSequence = useRef(0);

  const online = api?.status === "online";
  const fileQuery = trigger?.kind === "file" ? trigger.query : null;
  const canListFiles = api?.capabilities.list_files === true;

  useEffect(() => {
    if (triggerKey === null) {
      setDismissedKey(null);
    }
  }, [triggerKey]);

  useEffect(() => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;

    if (!api || !online || !canListFiles || fileQuery === null) {
      setFiles([]);
      setLoadingFiles(false);
      return;
    }

    setLoadingFiles(true);
    const timer = window.setTimeout(() => {
      void api
        .listFiles(fileQuery, PI_COMPOSER_FILE_QUERY_LIMIT)
        .then((next) => {
          if (requestSequence.current === sequence) {
            setFiles(next);
          }
        })
        .catch(() => {
          if (requestSequence.current === sequence) {
            setFiles([]);
          }
        })
        .finally(() => {
          if (requestSequence.current === sequence) {
            setLoadingFiles(false);
          }
        });
    }, PI_COMPOSER_FILE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [api, canListFiles, fileQuery, online]);

  const catalogItems = useMemo(
    () =>
      trigger?.kind === "slash"
        ? piComposerCatalogSuggestions(api?.catalog ?? null, trigger.query)
        : [],
    [api?.catalog, trigger],
  );

  const fileItems = useMemo(
    () => (fileQuery === null ? [] : piComposerFileSuggestions(files, fileQuery)),
    [fileQuery, files],
  );

  const items = trigger?.kind === "slash" ? catalogItems : fileItems;
  const available =
    trigger !== null &&
    online &&
    (trigger.kind === "slash" ? api?.catalog != null : canListFiles);
  const isOpen = available && triggerKey !== dismissedKey;

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length, triggerKey]);

  const moveActive = useCallback(
    (delta: number) => {
      if (items.length === 0) {
        return;
      }
      setActiveIndex((current) => (current + delta + items.length) % items.length);
    },
    [items.length],
  );

  const close = useCallback(() => {
    if (triggerKey !== null) {
      setDismissedKey(triggerKey);
    }
  }, [triggerKey]);

  const pick = useCallback(
    (item: PiComposerSuggestion): PiComposerSuggestionPick | null => {
      if (!trigger) {
        return null;
      }
      const next = applyPiComposerSuggestion(draft, trigger, cursor, item.insert);
      const nextTrigger = piComposerTrigger(next.value, next.cursor);
      setDismissedKey(piComposerTriggerKey(nextTrigger));
      setFiles([]);
      return next;
    },
    [cursor, draft, trigger],
  );

  const pickActive = useCallback(() => {
    const item = items[activeIndex];
    return item ? pick(item) : null;
  }, [activeIndex, items, pick]);

  return {
    trigger,
    isOpen,
    items,
    activeIndex,
    setActiveIndex,
    moveActive,
    pick,
    pickActive,
    close,
    loadingFiles,
    query: trigger?.query ?? "",
  };
}
