import { BookOpenText, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { trapFocusWithin, useFocusReturn } from "../../overlayFocus";
import { usePiBridge } from "../PiBridgeContext";
import { ReaderMarkdown } from "./ReaderMarkdown";
import "./reader.css";

const DISMISS_DRAG_PX = 96;

/**
 * Pull-up Reader Sheet for one Pi Pane. It owns no connection of its own: it
 * reads the selected pane's Pi mode client, and stays entirely absent while
 * that bridge is connecting, offline or unknown.
 */
export function ReaderSheet({ paneId }: { paneId: string }) {
  const bridge = usePiBridge(paneId);
  const [open, setOpen] = useState(false);

  if (!bridge || bridge.status !== "online") {
    return null;
  }

  return (
    <>
      <button
        className="reader-launcher"
        type="button"
        aria-label="Open Reader Sheet"
        onClick={() => setOpen(true)}
      >
        <BookOpenText size={18} />
        <span>Reader</span>
      </button>
      {open ? (
        <ReaderSheetPanel
          message={bridge.assistantMessage}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ReaderSheetPanel({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dragStart = useRef<{ pointerId: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  useFocusReturn();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const endDrag = () => {
    const dragged = dragY;
    dragStart.current = null;
    setDragging(false);
    if (dragged >= DISMISS_DRAG_PX) {
      onClose();
      return;
    }
    setDragY(0);
  };

  return (
    <div className="overlay-root reader-overlay">
      <button
        className="overlay-scrim"
        type="button"
        tabIndex={-1}
        aria-label="Dismiss Reader Sheet"
        onClick={onClose}
      />
      <section
        className="reader-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={
          dragY > 0 || dragging
            ? {
                transform: `translateY(${dragY}px)`,
                transition: dragging ? "none" : undefined,
              }
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <header
          className="reader-sheet-header"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target instanceof HTMLButtonElement) {
              return;
            }
            dragStart.current = { pointerId: event.pointerId, y: event.clientY };
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = dragStart.current;
            if (!start || start.pointerId !== event.pointerId) {
              return;
            }
            setDragY(Math.max(0, event.clientY - start.y));
          }}
          onPointerUp={(event) => {
            if (dragStart.current?.pointerId !== event.pointerId) {
              return;
            }
            endDrag();
          }}
          onPointerCancel={endDrag}
        >
          <span className="reader-grabber" aria-hidden="true" />
          <h2 id={titleId} className="reader-sheet-title">
            Reader
          </h2>
          <button
            ref={closeRef}
            className="reader-sheet-close"
            type="button"
            aria-label="Close Reader Sheet"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="note-body-preview reader-markdown" aria-live="polite">
          {message ? (
            <ReaderMarkdown text={message} />
          ) : (
            <p className="reader-empty">No assistant message yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
