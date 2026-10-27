import { Send, TextCursorInput } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";

import { autosizeMobileCommandTextarea } from "../mobileCommandTextarea";
import { piComposerDeliveryParts } from "./piComposerDelivery";
import { usePiComposerDraft } from "./piComposerDraft";
import "./pi-mode.css";

export type PiComposerProps = {
  bridgeId: string;
  paneId: string;
  /** Phone layout: always open, Enter inserts a newline, tap the big Send button. */
  mobile: boolean;
  /** Whether this pane owns keyboard focus (selected or focused pane). */
  active: boolean;
  /** Terminal is not attached, so sending would be lost. */
  disabled: boolean;
  /** Lets TerminalView route its own focus requests into the Composer field. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Parent focus request token; focuses the field while the Composer is open. */
  focusToken?: number;
  /** Returns true only when the bytes were handed to the terminal socket. */
  onSend: (parts: string[]) => boolean;
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
  const [value, setValue] = usePiComposerDraft(bridgeId, paneId);
  const [open, setOpen] = useState(mobile);

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
  }, []);

  const closeComposer = useCallback(() => {
    setOpen(mobile);
    onTerminalFocus();
  }, [mobile, onTerminalFocus]);

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

  const send = () => {
    if (disabled || composingRef.current) {
      return;
    }
    const parts = piComposerDeliveryParts(value);
    if (parts.length === 0) {
      return;
    }
    if (onSend(parts)) {
      setValue("");
    }
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (event.key === "Escape") {
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
          spellCheck
          disabled={disabled}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onFieldKeyDown}
        />
        <button
          className="term-send pi-composer-send"
          type="submit"
          disabled={disabled || value.length === 0}
          aria-label="Send prompt"
          title="Send (Ctrl+Enter)"
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
