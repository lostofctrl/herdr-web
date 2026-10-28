import { useEffect, useRef } from "react";

import type { PiComposerSuggestion } from "./piComposerSuggest";

export type PiComposerSuggestProps = {
  id: string;
  items: PiComposerSuggestion[];
  activeIndex: number;
  loading: boolean;
  onActiveChange: (index: number) => void;
  onPick: (item: PiComposerSuggestion) => void;
};

/**
 * Touch-first suggestion list. Rows use `mousedown` prevention so tapping one
 * never moves focus off the field (and never re-opens the mobile keyboard).
 */
export function PiComposerSuggest({
  id,
  items,
  activeIndex,
  loading,
  onActiveChange,
  onPick,
}: PiComposerSuggestProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      `[data-suggestion-index="${activeIndex}"]`,
    );
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, items.length]);

  return (
    <div
      ref={listRef}
      id={id}
      className="pi-composer-suggest"
      role="listbox"
      aria-label="Prompt suggestions"
      data-pi-suggestion-popup="true"
    >
      {items.length === 0 ? (
        <div className="pi-composer-suggest-empty" role="status">
          {loading ? "Searching files…" : "No matches"}
        </div>
      ) : (
        items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            data-pi-suggestion="true"
            data-suggestion-index={index}
            data-suggestion-label={item.label}
            data-kind={item.kind}
            className="pi-composer-suggest-row"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActiveChange(index)}
            onClick={() => onPick(item)}
          >
            <span className="pi-composer-suggest-label">{item.label}</span>
            {item.description ? (
              <span className="pi-composer-suggest-description">
                {item.description}
              </span>
            ) : null}
            <span className="pi-composer-suggest-kind">{item.kind}</span>
          </button>
        ))
      )}
    </div>
  );
}
