import { useEffect, useRef, useState } from "react";
import "./pi-composer-history.css";

export type PiComposerHistoryProps = {
  entries: readonly string[];
  onPick: (text: string) => void;
  onClear: () => void;
  onClose: () => void;
};

/** Two-line preview keeps the list scannable without hiding the prompt start. */
function preview(text: string) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

/**
 * Searchable, newest-first recall panel. It only reports a pick; the Composer
 * decides how the draft is replaced, so nothing here can send a prompt.
 */
export function PiComposerHistory({ entries, onPick, onClear, onClose }: PiComposerHistoryProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = entries.filter((entry) => {
    if (terms.length === 0) return true;
    const haystack = entry.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pi-composer-history" role="dialog" aria-label="Prompt history">
      <input
        ref={searchRef}
        type="search"
        aria-label="Search prompt history"
        placeholder="Search past prompts"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {entries.length === 0 ? (
        <p role="status">No prompts yet. Sent prompts appear here until you clear them.</p>
      ) : matches.length === 0 ? (
        <p role="status">No matching prompts</p>
      ) : (
        <ul aria-label="Past prompts">
          {matches.map((entry, index) => (
            <li key={`${index}:${entry}`}>
              <button type="button" data-pi-history-entry onClick={() => onPick(entry)}>
                {preview(entry)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pi-composer-history-actions">
        <button type="button" aria-label="Clear history" disabled={entries.length === 0} onClick={onClear}>
          Clear history
        </button>
        <button type="button" aria-label="Close prompt history" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
