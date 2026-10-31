import { useRef, useState, type KeyboardEvent } from "react";

import { usePiBridge, type PiBridgeApi } from "../PiBridgeContext";
import type { PiTreePicker } from "../piProtocol";
import "./cards.css";

type PiTreePickerCardProps = {
  picker: PiTreePicker;
  answerTreePicker: PiBridgeApi["answerTreePicker"];
  cancelTreePicker: PiBridgeApi["cancelTreePicker"];
};

function pickerError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /offline/i.test(message)
    ? "Pi Bridge is offline. Choose the entry in the terminal instead."
    : message;
}

/**
 * The `/herdr-tree` picker Pi opened in the terminal. Pi published these entry
 * ids for this picker only; the card cannot navigate anything else, and the
 * terminal stays in control of the session.
 */
export function PiTreePickerCard({ picker, answerTreePicker, cancelTreePicker }: PiTreePickerCardProps) {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filterText, setFilterText] = useState("");
  const composingRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleNodes = picker.nodes.filter((node) =>
    node.label.toLowerCase().includes(filter.toLowerCase()),
  );
  const activeId = visibleNodes.some((node) => node.entry_id === selectedId)
    ? selectedId
    : visibleNodes[0]?.entry_id;

  async function settle(action: { entryId: string } | { cancel: true }) {
    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setError(null);
    setSending(true);
    try {
      const result =
        "cancel" in action
          ? await cancelTreePicker(picker.id)
          : await answerTreePicker(picker.id, action.entryId);
      if (!result.accepted) {
        setError("Pi is no longer waiting for this picker.");
      }
    } catch (caught) {
      setError(pickerError(caught));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleListKey(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || composingRef.current || sendingRef.current) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!visibleNodes.length) return;
      const focusedId = event.target instanceof HTMLButtonElement ? event.target.dataset.entryId : activeId;
      const currentIndex = visibleNodes.findIndex((node) => node.entry_id === focusedId);
      const nextIndex = currentIndex < 0 ? 0 : Math.max(0, Math.min(visibleNodes.length - 1,
        currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const next = visibleNodes[nextIndex];
      setSelectedId(next.entry_id);
      const button = listRef.current?.querySelectorAll<HTMLButtonElement>("button")[nextIndex];
      if (event.target instanceof HTMLButtonElement) button?.focus();
      else button?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const focusedId = event.target instanceof HTMLButtonElement ? event.target.dataset.entryId : activeId;
      const selected = visibleNodes.find((node) => node.entry_id === focusedId) ?? visibleNodes[0];
      if (selected) void settle({ entryId: selected.entry_id });
    }
  }

  return (
    <section
      className="pi-dialog-card pi-tree-picker"
      data-pi-tree-picker="true"
      aria-label={picker.title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          void settle({ cancel: true });
        }
      }}
    >
      <div className="pi-dialog-card-head">
        <h2 className="pi-dialog-card-title">{picker.title}</h2>
        <button
          className="pi-dialog-card-cancel"
          type="button"
          disabled={sending}
          onClick={() => void settle({ cancel: true })}
        >
          Cancel
        </button>
      </div>
      <p className="pi-dialog-card-message">
        Choosing an entry moves this Pi session to it. Newer messages and Pi summaries are not
        created, so use /tree in the terminal for those.
      </p>

      {picker.nodes.length >= 12 ? (
        <div className="pi-dialog-card-input">
          <input
            aria-label="Filter published entries"
            placeholder="Filter published entries"
            value={filterText}
            disabled={sending}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setFilter(event.currentTarget.value);
            }}
            onChange={(event) => {
              setFilterText(event.target.value);
              if (!composingRef.current) setFilter(event.target.value);
            }}
            onKeyDown={handleListKey}
          />
        </div>
      ) : null}
      {visibleNodes.length === 0 ? <p className="pi-dialog-card-message">No published entries match.</p> : null}
      <div ref={listRef} className="pi-dialog-card-options" role="group" aria-label={picker.title} onKeyDown={handleListKey}>
        {visibleNodes.map((node) => (
          <button
            className="pi-dialog-card-option"
            type="button"
            key={node.entry_id}
            disabled={sending}
            data-entry-id={node.entry_id}
            data-current={node.current ? "true" : undefined}
            data-selected={node.entry_id === activeId ? "true" : undefined}
            onFocus={() => setSelectedId(node.entry_id)}
            aria-current={node.current ? "true" : undefined}
            style={{ paddingLeft: `${12 + node.depth * 14}px` }}
            onClick={() => void settle({ entryId: node.entry_id })}
          >
            <span className="pi-dialog-card-option-label">{node.label}</span>
            {node.current ? <span className="pi-dialog-card-option-description">current</span> : null}
          </button>
        ))}
      </div>

      {picker.omitted > 0 ? (
        <p className="pi-dialog-card-message" role="status">
          {picker.omitted} {picker.omitted === 1 ? "entry is" : "entries are"} only in the
          terminal /tree picker.
        </p>
      ) : null}

      {error ? (
        <p className="pi-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The single tree-picker card for one Pi pane, shown only when one is waiting. */
export function PiTreePickerCards({ paneId }: { paneId: string }) {
  const bridge = usePiBridge(paneId);
  if (!bridge || bridge.treePickers.length === 0) {
    return null;
  }
  return (
    <div className="pi-dialog-cards" data-pi-tree-picker-cards="true">
      {bridge.treePickers.map((picker) => (
        <PiTreePickerCard
          key={picker.id}
          picker={picker}
          answerTreePicker={bridge.answerTreePicker}
          cancelTreePicker={bridge.cancelTreePicker}
        />
      ))}
    </div>
  );
}
