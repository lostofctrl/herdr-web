import { Keyboard, Plus, Send } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  MOBILE_TERMINAL_MODIFIERS,
  MOBILE_TERMINAL_SPECIAL_KEYS,
  encodeMobileTerminalChord,
  formatMobileTerminalChord,
  mobileTerminalPrintableKey,
} from "../../mobileTerminalControls";
import type {
  MobileTerminalChordKey,
  MobileTerminalModifier,
} from "../../mobileTerminalControls";
import { usePiBridge } from "../PiBridgeContext";
import { piKeyBarKeys, piKeyBarState } from "./piKeyBarKeys";
import "./pi-key-bar.css";

export type PiKeyBarProps = {
  paneId: string;
  /** Terminal is not attached, so a keypress would be lost. */
  disabled: boolean;
  /** Writes raw terminal bytes through the pane's existing input path. */
  onInput: (data: string) => void;
  /** Reports this bar's height so the stack above it clears the Key Bar too. */
  onControlsHeightChange?: (heightPx: number | null) => void;
};

// Keys act on the focused terminal/input without moving focus, so a thumb never
// loses the Composer (or closes the soft keyboard) by tapping a key. Every
// pointer type is covered: a mouse click would otherwise focus the button and
// send the next keystroke nowhere. Nothing here needs the button to be focusable
// by pointer, and keyboard users still reach it through Tab.
function preserveInputFocus(event: ReactPointerEvent<HTMLButtonElement>) {
  event.preventDefault();
}

/**
 * Context-aware Key Bar for a Pi Pane. Its keys follow Pi State and every tap
 * writes the same legacy VT bytes the mobile key panel already sends. When the
 * Pi Bridge is not online it keeps the idle set, so the bar never disappears
 * and `⋯` can always reach the Chord Composer.
 */
export function PiKeyBar({
  paneId,
  disabled,
  onInput,
  onControlsHeightChange,
}: PiKeyBarProps) {
  const bridge = usePiBridge(paneId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const state = piKeyBarState(bridge?.status ?? "offline", bridge?.state?.busy ?? null);
  const keys = piKeyBarKeys(state);
  const [chordOpen, setChordOpen] = useState(false);
  const [modifiers, setModifiers] = useState<MobileTerminalModifier[]>([]);
  const [chordKey, setChordKey] = useState<MobileTerminalChordKey | null>(null);
  const [printableKey, setPrintableKey] = useState("");

  const resetComposer = useCallback(() => {
    setChordOpen(false);
    setModifiers([]);
    setChordKey(null);
    setPrintableKey("");
  }, []);

  const chooseKey = (key: MobileTerminalChordKey) => {
    setChordKey((current) => (current?.id === key.id ? null : key));
    setPrintableKey("");
  };

  const toggleModifier = (modifier: MobileTerminalModifier) => {
    setModifiers((current) =>
      current.includes(modifier)
        ? current.filter((candidate) => candidate !== modifier)
        : [...current, modifier],
    );
  };

  const chordLabel = chordKey ? formatMobileTerminalChord(chordKey, modifiers) : null;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !onControlsHeightChange) {
      onControlsHeightChange?.(null);
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
  }, [onControlsHeightChange, chordOpen]);

  const sendChord = () => {
    if (disabled || !chordKey) {
      return;
    }
    onInput(encodeMobileTerminalChord(chordKey, modifiers));
    resetComposer();
  };

  return (
    <div className="pi-key-bar" data-state={state} data-chord-open={chordOpen} ref={rootRef}>
      <div className="pi-key-bar-row" role="group" aria-label="Pi keys">
        {keys.map((key) => (
          <button
            key={key.id}
            className="term-key pi-key-bar-key"
            type="button"
            aria-label={key.ariaLabel}
            title={key.ariaLabel}
            disabled={disabled}
            onPointerDown={preserveInputFocus}
            onClick={() => onInput(key.data)}
          >
            <span className="pi-key-bar-glyph">{key.label}</span>
            {key.hint ? <span className="pi-key-bar-hint">{key.hint}</span> : null}
          </button>
        ))}
        <button
          className="term-key term-key-icon pi-key-bar-key"
          type="button"
          aria-label={chordOpen ? "Close key composer" : "Compose any key"}
          aria-expanded={chordOpen}
          title={chordOpen ? "Close and discard chord" : "Compose key"}
          disabled={disabled && !chordOpen}
          onClick={() => (chordOpen ? resetComposer() : setChordOpen(true))}
        >
          <span className="pi-key-bar-glyph" aria-hidden="true">
            {chordOpen ? (
              <Keyboard size={15} />
            ) : (
              <span className="pi-key-bar-more">
                <Keyboard size={15} />
                <Plus className="term-key-compose-plus" size={8} />
              </span>
            )}
          </span>
          <span className="pi-key-bar-hint">{chordOpen ? "Close" : "Any key"}</span>
        </button>
      </div>

      {chordOpen ? (
        <div className="term-key-composer" aria-label="Pi key composer">
          <div className="term-key-composer-preview">
            <div className="term-key-composer-preview-label" aria-live="polite">
              <span>Building shortcut</span>
              <strong>{chordLabel ?? "Choose a key"}</strong>
            </div>
            <button
              className="term-key"
              type="button"
              aria-label="Cancel shortcut"
              onClick={resetComposer}
            >
              Cancel
            </button>
            <button
              className="term-key term-key-chord-send"
              type="button"
              aria-label={chordLabel ? `Send ${chordLabel}` : "Send composed key"}
              title="Send composed key"
              disabled={disabled || !chordKey}
              onClick={sendChord}
            >
              <Send size={16} aria-hidden="true" /> Send
            </button>
          </div>
          <div className="term-key-composer-modifiers" aria-label="Chord modifiers">
            {MOBILE_TERMINAL_MODIFIERS.map((modifier) => {
              const active = modifiers.includes(modifier.id);
              return (
                <button
                  key={modifier.id}
                  className="term-key"
                  type="button"
                  data-active={active ? "true" : "false"}
                  aria-pressed={active}
                  aria-label={`${active ? "Remove" : "Add"} ${modifier.label} modifier`}
                  disabled={disabled}
                  onPointerDown={preserveInputFocus}
                  onClick={() => toggleModifier(modifier.id)}
                >
                  {modifier.label}
                </button>
              );
            })}
          </div>
          <div className="term-key-composer-capture">
            <label>
              <span>Printable key</span>
              <input
                className="mono"
                type="text"
                aria-label="Printable key"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                inputMode="text"
                spellCheck={false}
                value={printableKey}
                disabled={disabled}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  const nextPrintableKey = Array.from(event.target.value).at(-1) ?? "";
                  setPrintableKey(nextPrintableKey);
                  setChordKey(
                    nextPrintableKey ? mobileTerminalPrintableKey(nextPrintableKey) : null,
                  );
                }}
              />
            </label>
          </div>
          <div className="pi-key-bar-chord-keys" role="group" aria-label="Composed key">
            {MOBILE_TERMINAL_SPECIAL_KEYS.map((key) => (
              <button
                key={key.id}
                className="term-key"
                type="button"
                aria-label={`Use ${key.name} key`}
                aria-pressed={chordKey?.id === key.id}
                data-active={chordKey?.id === key.id ? "true" : "false"}
                disabled={disabled}
                onPointerDown={preserveInputFocus}
                onClick={() => chooseKey(key)}
              >
                {key.label}
              </button>
            ))}
          </div>
          <p>Tap a key, add modifiers, then Send. Cancel returns to the Pi keys.</p>
        </div>
      ) : null}
    </div>
  );
}