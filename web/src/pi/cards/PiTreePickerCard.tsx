import { useRef, useState } from "react";

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

  return (
    <section
      className="pi-dialog-card pi-tree-picker"
      data-pi-tree-picker="true"
      aria-label={picker.title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
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

      <div className="pi-dialog-card-options" role="group" aria-label={picker.title}>
        {picker.nodes.map((node) => (
          <button
            className="pi-dialog-card-option"
            type="button"
            key={node.entry_id}
            disabled={sending}
            data-entry-id={node.entry_id}
            data-current={node.current ? "true" : undefined}
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
