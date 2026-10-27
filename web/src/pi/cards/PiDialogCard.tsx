import { useEffect, useState } from "react";

import { usePiBridge, type PiBridgeApi } from "../PiBridgeContext";
import type { PiDialog } from "../piProtocol";
import { PiQuestionCard } from "./PiQuestionCard";
import "./cards.css";

type GenericDialog = PiDialog & { kind: "select" | "confirm" | "input" };

type PiDialogCardProps = {
  dialog: GenericDialog;
  answerDialog: PiBridgeApi["answerDialog"];
};

const KIND_LABEL: Record<GenericDialog["kind"], string> = {
  select: "Choose one",
  confirm: "Confirm",
  input: "Enter a value",
};

function secondsRemaining(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return null;
  }
  return Math.max(0, Math.ceil(timeoutMs / 1000));
}

function answerError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /offline/i.test(message)
    ? "Pi Bridge is offline. Answer from the terminal or retry when it reconnects."
    : message;
}

/**
 * One touch Native Card for a shared `ctx.ui` dialog wrapped by the Pi Bridge.
 * Pi owns the timeout; this only renders a countdown and the card disappears
 * when the bridge relays `dialog_closed`.
 */
export function PiDialogCard({ dialog, answerDialog }: PiDialogCardProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [remaining, setRemaining] = useState(() => secondsRemaining(dialog.timeout_ms));

  useEffect(() => {
    if (remaining === null || remaining <= 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRemaining((current) => (current === null ? null : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  async function settle(answer: { value: string | boolean } | { cancel: true }) {
    if (sending) {
      return;
    }
    setError(null);
    setSending(true);
    try {
      const result = await answerDialog(dialog.id, answer);
      if (!result.accepted) {
        setError("Another surface answered this dialog first.");
      }
    } catch (caught) {
      setError(answerError(caught));
    } finally {
      setSending(false);
    }
  }

  const title = dialog.title || KIND_LABEL[dialog.kind];

  return (
    <section
      className="pi-dialog-card"
      data-pi-dialog-card="true"
      data-kind={dialog.kind}
      aria-label={title}
    >
      <div className="pi-dialog-card-head">
        <h2 className="pi-dialog-card-title">{title}</h2>
        {remaining !== null ? (
          <span className="pi-dialog-card-timeout" role="timer" aria-live="off">
            {remaining > 0 ? `${remaining}s remaining` : "Timed out"}
          </span>
        ) : null}
        <button
          className="pi-dialog-card-cancel"
          type="button"
          disabled={sending}
          onClick={() => void settle({ cancel: true })}
        >
          Cancel
        </button>
      </div>
      {dialog.message ? <p className="pi-dialog-card-message">{dialog.message}</p> : null}

      {dialog.kind === "select" ? (
        <div className="pi-dialog-card-options" role="group" aria-label={title}>
          {(dialog.options ?? []).map((option, index) => (
            <button
              className="pi-dialog-card-option"
              type="button"
              key={`${option.label}-${index}`}
              disabled={sending}
              onClick={() => void settle({ value: option.label })}
            >
              <span className="pi-dialog-card-option-label">{option.label}</span>
              {option.description ? (
                <span className="pi-dialog-card-option-description">{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {dialog.kind === "confirm" ? (
        <div className="pi-dialog-card-actions">
          <button
            className="pi-dialog-card-secondary"
            type="button"
            disabled={sending}
            onClick={() => void settle({ value: false })}
          >
            No
          </button>
          <button
            className="pi-dialog-card-primary"
            type="button"
            disabled={sending}
            onClick={() => void settle({ value: true })}
          >
            Yes
          </button>
        </div>
      ) : null}

      {dialog.kind === "input" ? (
        <form
          className="pi-dialog-card-input"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length > 0) {
              void settle({ value: text });
            }
          }}
        >
          <input
            type="text"
            aria-label={title}
            placeholder={dialog.placeholder ?? ""}
            value={text}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            className="pi-dialog-card-primary"
            type="submit"
            disabled={sending || text.length === 0}
          >
            Send
          </button>
        </form>
      ) : null}

      {error ? (
        <p className="pi-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The single Native Card list for one Pi Pane. Question dialogs and wrapped
 * generic dialogs share it, deduped by dialog id; generic cards are hidden
 * when the bridge could not install the `ctx.ui` wrap.
 */
export function PiDialogCards({ paneId }: { paneId: string }) {
  const bridge = usePiBridge(paneId);
  if (!bridge) {
    return null;
  }
  const genericEnabled = bridge.capabilities.generic_dialogs === true;
  const seen = new Set<string>();
  const dialogs = bridge.dialogs.filter((dialog) => {
    if (seen.has(dialog.id) || (dialog.kind !== "question" && !genericEnabled)) {
      return false;
    }
    seen.add(dialog.id);
    return true;
  });
  if (dialogs.length === 0) {
    return null;
  }
  return (
    <div className="pi-dialog-cards" data-pi-dialog-cards="true">
      {dialogs.map((dialog) =>
        dialog.kind === "question" ? (
          <PiQuestionCard key={dialog.id} dialog={dialog} answerDialog={bridge.answerDialog} />
        ) : (
          <PiDialogCard
            key={dialog.id}
            dialog={dialog as GenericDialog}
            answerDialog={bridge.answerDialog}
          />
        ),
      )}
    </div>
  );
}
