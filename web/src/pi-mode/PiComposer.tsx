import { Send, TextCursorInput } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";

import {
  compositionGuardDeadline,
  isLateCompositionEdit,
} from "../commandTextFieldGuard";
import { hasOpenMenu, hasOpenModal, isShortcutTextEntryTarget } from "../keyboardShortcutTargets";
import { autosizeMobileCommandTextarea } from "../mobileCommandTextarea";
import { piComposerDeliveryParts } from "./piComposerDelivery";
import { usePiComposerDraft } from "./piComposerDraft";
import "./pi-mode.css";

export type PiComposerProps = {
  bridgeId: string;
  paneId: string;
  /** Phone layout: always open, Enter inserts a newline, tap the big Send button. */
  mobile: boolean;
  /** Phone Key Bar and chord composer rendered above the prompt field. */
  keyBar?: ReactNode;
  /** Whether this pane owns keyboard focus (only the selected pane opens on Ctrl+Space). */
  active: boolean;
  /** Terminal is not attached, so sending would be lost. */
  disabled: boolean;
  /** Lets TerminalView route its own focus requests into the Composer field. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Parent focus request token; focuses the field while the Composer is open. */
  focusToken?: number;
  /**
   * Queues the prompt on the terminal socket. Returns false when nothing was
   * queued, which keeps the draft. `onDelivered` reports how many of the queued
   * frames reached the socket: `0` means nothing was sent, fewer than
   * `totalParts` means a partially delivered prompt, so a cancelled send never
   * clears the draft.
   */
  onSend: (
    parts: string[],
    onDelivered: (deliveredParts: number, totalParts: number) => void,
  ) => boolean;
  onTerminalFocus: () => void;
  onControlsHeightChange: (heightPx: number | null) => void;
};

/**
 * Native Pi Composer. Delivery is one bracketed paste plus a separate Enter,
 * so it works the same whether or not the Pi Bridge is reachable.
 */
export function PiComposer({
  bridgeId,
  paneId,
  mobile,
  keyBar,
  active,
  disabled,
  inputRef,
  focusToken = 0,
  onSend,
  onTerminalFocus,
  onControlsHeightChange,
}: PiComposerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const focusOnOpenRef = useRef(false);
  const composingRef = useRef(false);
  // Guards survive re-renders and keep a sent value from being restored.
  const compositionGuardUntilRef = useRef(0);
  const acceptedValueRef = useRef("");
  const pendingSendRef = useRef(false);
  const [value, setValue] = usePiComposerDraft(bridgeId, paneId);
  const [open, setOpen] = useState(mobile);
  /** The prompt text reached Pi but its Enter did not, so resending must not paste again. */
  const [awaitingSubmit, setAwaitingSubmit] = useState(false);
  acceptedValueRef.current = value;

  useEffect(() => {
    if (mobile) {
      setOpen(true);
    }
  }, [mobile]);

  const setFieldNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      fieldRef.current = node;
      if (inputRef) {
        inputRef.current = node;
      }
    },
    [inputRef],
  );

  const openComposer = useCallback(() => {
    focusOnOpenRef.current = true;
    setOpen(true);
    // Ctrl+Space also returns focus to an already open Composer.
    fieldRef.current?.focus();
  }, []);

  const closeComposer = useCallback(() => {
    setOpen(false);
    onTerminalFocus();
  }, [onTerminalFocus]);

  // Desktop defaults to terminal focus; Ctrl+Space is the only way in.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === " " &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        // Ctrl+Space is an app shortcut, so it never steals a key from a text
        // field, an open dialog, or an open menu.
        if (hasOpenModal() || hasOpenMenu() || isShortcutTextEntryTarget(event.target)) {
          return;
        }
        event.preventDefault();
        openComposer();
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", onDocumentKeyDown, true);
  }, [active, openComposer]);

  useLayoutEffect(() => {
    if (open && focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      fieldRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open || focusToken === 0) {
      return;
    }
    fieldRef.current?.focus();
  }, [focusToken, open]);

  useLayoutEffect(() => {
    if (open) {
      autosizeMobileCommandTextarea(fieldRef.current);
    }
  }, [open, value]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      onControlsHeightChange(null);
      return;
    }
    const report = () => onControlsHeightChange(root.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", report);
      return () => {
        window.removeEventListener("resize", report);
        onControlsHeightChange(null);
      };
    }
    const observer = new ResizeObserver(report);
    observer.observe(root);
    return () => {
      observer.disconnect();
      onControlsHeightChange(null);
    };
  }, [onControlsHeightChange, open]);

  const clearAcceptedValue = useCallback(() => {
    // Reject delayed IME composition edits that would otherwise restore the sent
    // text into the field and the stored draft, mirroring the command composer.
    compositionGuardUntilRef.current = compositionGuardDeadline();
    acceptedValueRef.current = "";
    setValue("");
  }, [setValue]);

  const onFieldChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (isLateCompositionEdit(event.nativeEvent, compositionGuardUntilRef.current)) {
      event.currentTarget.value = acceptedValueRef.current;
      return;
    }
    acceptedValueRef.current = event.currentTarget.value;
    setValue(event.currentTarget.value);
  };

  const send = () => {
    // The draft clears only after the last frame reaches the socket, so a second
    // Send or Ctrl+Enter while that is pending would deliver the prompt twice.
    if (disabled || composingRef.current || pendingSendRef.current) {
      return;
    }
    // A partially delivered prompt already sits in Pi's editor, so finishing it
    // must send the Enter alone instead of pasting the text a second time.
    const parts = awaitingSubmit ? ["\r"] : piComposerDeliveryParts(value);
    // A blank draft would submit an empty prompt, so it is never delivered.
    if (parts.length === 0 || (!awaitingSubmit && value.trim().length === 0)) {
      return;
    }
    const sentValue = value;
    pendingSendRef.current = true;
    let settled = false;
    const accepted = onSend(parts, (deliveredParts, totalParts) => {
      settled = true;
      pendingSendRef.current = false;
      if (deliveredParts === totalParts) {
        setAwaitingSubmit(false);
        if (acceptedValueRef.current === sentValue) {
          clearAcceptedValue();
        }
        return;
      }
      // Keep the text so the prompt is recoverable, but record that Pi already
      // has it, so the next send only finishes the submission.
      setAwaitingSubmit(deliveredParts > 0);
    });
    if (!accepted && !settled) {
      pendingSendRef.current = false;
    }
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (event.key === "Escape" && !mobile) {
      event.preventDefault();
      closeComposer();
      return;
    }
    if (!mobile && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      send();
    }
  };

  if (!open) {
    return (
      <div
        ref={rootRef}
        className="terminal-command-controls pi-composer"
        data-mobile-controls="false"
      >
        <button
          className="term-send pi-composer-open"
          type="button"
          aria-label="Open Composer"
          title="Open Composer (Ctrl+Space)"
          onClick={openComposer}
        >
          <TextCursorInput size={16} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="terminal-command-controls pi-composer"
      data-mobile-controls={mobile ? "true" : "false"}
    >
      {keyBar}
      {awaitingSubmit ? (
        <p className="pi-composer-recovery" role="status">
          Prompt text reached Pi without Enter. Send submits it without pasting again.
        </p>
      ) : null}
      <form
        className="term-input-row pi-composer-row"
        data-expanding="true"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={setFieldNode}
          className="term-native-input mono pi-composer-input"
          rows={1}
          data-expanding="true"
          aria-label="Pi prompt"
          placeholder="Write a prompt for Pi"
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          enterKeyHint={mobile ? "enter" : "send"}
          spellCheck
          disabled={disabled}
          value={value}
          onChange={onFieldChange}
          onCompositionStart={() => {
            composingRef.current = true;
            // A new composition belongs to the next prompt, so it must not be
            // treated as a late edit of the one that was just sent.
            compositionGuardUntilRef.current = 0;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onFieldKeyDown}
        />
        <button
          className="term-send pi-composer-send"
          type="submit"
          disabled={disabled || value.trim().length === 0}
          aria-label={awaitingSubmit ? "Submit prompt" : "Send prompt"}
          title={awaitingSubmit ? "Submit the pasted prompt" : "Send (Ctrl+Enter)"}
        >
          <Send size={16} />
          <span className="pi-composer-send-label">Send</span>
        </button>
        {!mobile ? (
          <button
            className="term-key pi-composer-close"
            type="button"
            aria-label="Close Composer"
            title="Close Composer (Esc)"
            onClick={closeComposer}
          >
            Esc
          </button>
        ) : null}
      </form>
    </div>
  );
}
