import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PiBridgeApi } from "../pi/PiBridgeContext";
import type { PiModel } from "../pi/piProtocol";
import {
  filterPiModels,
  piModelPickerPlacement,
  piModelKey,
  type PiModelPickerPlacement,
} from "./piModelPicker";
import "./pi-model-picker.css";

export type PiModelPickerProps = {
  api: PiBridgeApi | null;
  disabled?: boolean;
  /** Renders compact Composer trigger text; the side panel uses the same control. */
  compact?: boolean;
  /** Share the searchable picker inside the Composer-owned popup. */
  embedded?: boolean;
  /** Optional controlled open state so the Composer can keep one popup at a time. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * One searchable model control shared by the Composer and side panel. The
 * displayed model always comes from the authoritative bridge snapshot.
 */
export function PiModelPicker({ api, disabled = false, compact = false, embedded = false, open: openProp, onOpenChange }: PiModelPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const [placement, setPlacement] = useState<PiModelPickerPlacement | null>(null);
  const panelMounted = open && (embedded || placement !== null);
  const identity = api ? `${api.paneId}:${api.status}` : "";
  const pendingFor = useRef<string | null>(null);
  const listId = useId();
  const state = api?.state;
  const online = api?.status === "online";
  const current = state?.model ?? null;
  const currentKnown = !!current && (state?.models ?? []).some((model) => piModelKey(model) === piModelKey(current));
  const unavailable = current && !currentKnown ? current : null;
  const models = filterPiModels(state?.models ?? [], query);
  const label = current ? `${current.id}` : "Model";

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Pane switches and disconnects invalidate both the open panel and its result.
    if (!embedded) setOpen(false);
    setQuery("");
    setPending(false);
    setError(null);
    pendingFor.current = null;
  }, [identity]);

  useLayoutEffect(() => {
    if (!open || embedded) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPlacement(
        piModelPickerPlacement(
          { top: rect.top, bottom: rect.bottom, left: rect.left },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, embedded]);

  useEffect(() => {
    // Focus once, when the panel is on screen; repositioning must not steal focus
    // back from a model row the user tabbed to.
    if (!panelMounted) return;
    searchRef.current?.focus();
  }, [panelMounted]);

  useEffect(() => {
    if (!open || embedded) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  /**
   * Bumped whenever the panel opens or closes, so a model request started in an
   * earlier opening cannot close the panel or steal focus from the current one.
   */
  const openGeneration = useRef(0);

  function close() {
    openGeneration.current += 1;
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function toggle() {
    openGeneration.current += 1;
    setError(null);
    setOpen(!open);
  }

  function select(model: PiModel) {
    if (!api || pending || disabled || !online) return;
    const target = `${piModelKey(model)}:${identity}`;
    const generation = openGeneration.current;
    pendingFor.current = target;
    setPending(true);
    setError(null);
    void api.setModel(model.provider, model.id).then(() => {
      if (!mountedRef.current || pendingFor.current !== target) return;
      pendingFor.current = null;
      setPending(false);
      // The user moved on (closed or reopened the panel): settle the request but
      // leave their current focus and panel alone.
      if (openGeneration.current !== generation) return;
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus();
    }).catch((reason: unknown) => {
      // Stay open on failure so the error is visible next to the failed pick.
      if (!mountedRef.current || pendingFor.current !== target) return;
      pendingFor.current = null;
      setPending(false);
      if (openGeneration.current !== generation) return;
      setError(reason instanceof Error ? reason.message : "Model change failed.");
    });
  }

  return (
    <div ref={rootRef} className="pi-model-picker" data-compact={compact} data-open={open}>
      {!embedded ? <button ref={triggerRef} type="button" className="pi-model-picker-trigger"
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-label={`Current model: ${current ? `${current.id}, ${current.provider}` : "none"}`}
        title={current ? `${current.id} · ${current.provider}` : "Select model"}
        disabled={disabled || !online || !state}
        onClick={toggle}>
        <span>{label}</span>{compact ? null : current ? <small>{current.provider}</small> : null}
      </button> : null}
      {panelMounted ? (
        <div
          ref={panelRef}
          className="pi-model-picker-panel"
          role="dialog"
          aria-label="Select Pi model"
          id={listId}
          data-embedded={embedded}
          style={embedded || !placement ? undefined : {
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
          }}
        >
          <input ref={searchRef} type="search" aria-label="Search models" value={query}
            placeholder="Search label, id, provider" autoComplete="off"
            onChange={(event) => setQuery(event.target.value)} />
          {!online ? <p role="status">Bridge offline</p> : state?.models.length === 0 ? <p role="status">No models available</p>
            : unavailable ? <p className="pi-model-picker-unavailable" role="status">{unavailable.id} · {unavailable.provider} (unavailable)</p> : null}
          {pending ? <p role="status">Changing model…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          <ul role="listbox" aria-label="Models">
            {models.map((model) => {
              const selected = !!current && piModelKey(current) === piModelKey(model);
              return <li key={piModelKey(model)} role="option" aria-selected={selected}>
                <button type="button" disabled={pending || disabled || !online} data-model-key={piModelKey(model)}
                  onClick={() => select(model)}>
                  <strong>{model.label}</strong><small>{model.id} · {model.provider}</small>
                  {selected ? <span aria-label="Selected">✓</span> : null}
                </button>
              </li>;
            })}
          </ul>
          {online && state && state.models.length > 0 && models.length === 0 ? <p role="status">No matching models</p> : null}
        </div>
      ) : null}
    </div>
  );
}
