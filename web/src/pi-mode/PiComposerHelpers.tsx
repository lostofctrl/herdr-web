import type { ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  AtSign, Blocks, Brain, ChevronLeft, CornerDownLeft, Cpu, History, ImagePlus, Keyboard, SquareSlash, SquareTerminal,
} from "lucide-react";
import { PI_QUICK_ACTIONS, piQuickActionParts } from "../pi/sidepanel/piQuickActions";
import { PiModelPicker } from "./PiModelPicker";
import type { PiComposerProps } from "./PiComposer";
import type { PiBridgeApi } from "../pi/PiBridgeContext";
import { piCatalogTrigger, piSidePanelEntries } from "../pi/sidepanel/piSidePanelCatalog";
import "./pi-composer-helpers.css";

export type PiComposerHelper = "slash" | "file" | "shell";

type Props = {
  api: PiBridgeApi | null;
  tools?: ReactNode;
  onAttach?: () => void;
  onHistory: () => void;
  onQuickAction: PiComposerProps["onSend"];
  actionRecovery: boolean;
  actionPending: boolean;
  actionError: string | null;
  authoringBlocked: boolean;
  onInsertCatalog: (text: string) => void;
  open: boolean;
  disabled: boolean;
  online: boolean;
  filesAvailable: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (kind: PiComposerHelper) => void;
};

/** One popup owner for authoring helpers and explicit Pi actions. */
export function PiComposerHelpers({ api, tools, onAttach, onHistory, onQuickAction, actionRecovery, actionPending, actionError, authoringBlocked, onInsertCatalog, open, disabled, online, filesAvailable, onOpen, onClose, onPick }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const returnFocusRef = useRef<string | null>(null);
  const [view, setView] = useState<"root" | "catalog" | "thinking" | "model" | "tools">("root");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    ++generationRef.current;
    setPending(false);
    setError(null);
    return () => { ++generationRef.current; };
  }, [open, view, api?.paneId, api?.status]);
  const [bounds, setBounds] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; width: number }>({ left: 8, top: 8, maxHeight: 240, width: 280 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = Math.min(320, (viewport?.width ?? window.innerWidth) - 16);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const above = rect.top - top - 16;
      const below = bottom - rect.bottom - 16;
      const height = Math.min(280, Math.max(44, Math.max(above, below)));
      setBounds({
        left: Math.max(left + 8, Math.min(rect.left, left + (viewport?.width ?? window.innerWidth) - width - 8)),
        ...(above >= below ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: height,
        width,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const returning = view === "root" && returnFocusRef.current
        ? menuRef.current?.querySelector<HTMLButtonElement>(`[aria-label="${returnFocusRef.current}"]:not(:disabled)`)
        : null;
      (returning ?? menuRef.current?.querySelector<HTMLInputElement>("input") ?? menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    } else { setView("root"); setQuery(""); returnFocusRef.current = null; }
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if ((event.target as Element)?.closest?.("[data-pi-dialog-cards], .pi-composer-terminal")) {
        onClose();
        return;
      }
      // Consume the dismissal gesture rather than focusing/typing into the PTY.
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click") { onClose(); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("click", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("click", outside, true);
    };
  }, [open, onClose]);

  const catalogEntries = api?.catalog ? piSidePanelEntries(api.catalog, api.capabilities.skills_catalog === true, query) : [];
  const closeAndFocus = () => { onClose(); triggerRef.current?.focus(); };
  const quickAction = (parts: string[]) => {
    const generation = generationRef.current;
    onQuickAction(parts, (delivered, total) => {
      // Transport settlement belongs to Composer even after this popup closes.
      if (generation === generationRef.current && delivered === total) closeAndFocus();
    });
  };
  return (
    <div ref={rootRef} className="pi-composer-helpers" onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
    }}>
      <button ref={triggerRef} type="button" className="term-key pi-composer-helpers-trigger"
        aria-label="Composer helpers" title="Composer helpers" aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => open ? closeAndFocus() : onOpen()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); onOpen(); }
        }}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? <div ref={menuRef} id={id} role={view === "root" ? "menu" : "dialog"} aria-label={view === "root" ? "Composer helpers" : view === "tools" ? "Terminal keys and Reader" : view === "catalog" ? "Commands and skills" : view === "thinking" ? "Pi thinking levels" : "Pi model controls"}
        className="pi-composer-helpers-menu" style={bounds}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); return; }
          if (view !== "root") return;
          if (event.key === "Tab") { closeAndFocus(); return; }
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowDown" ? (index + 1) % buttons.length
            : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : null;
          if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
        }}>
        {view === "root" ? <>
        {([ ["slash", "/ Commands and skills", SquareSlash], ["file", "@ Files and paths", AtSign], ["shell", "! Shell command", SquareTerminal] ] as const).map(([kind, label, Icon]) => (
          <button key={kind} type="button" role="menuitem" tabIndex={-1} data-helper={kind}
            disabled={authoringBlocked} onClick={() => onPick(kind)}><Icon size={16} aria-hidden="true" />{label}</button>
        ))}
        {onAttach ? <button type="button" role="menuitem" tabIndex={-1} aria-label="Attach image" disabled={disabled} onClick={onAttach}><ImagePlus size={16} aria-hidden="true" />Attach image</button> : null}
        <button type="button" role="menuitem" tabIndex={-1} aria-label="Open prompt history" disabled={disabled} onClick={onHistory}><History size={16} aria-hidden="true" />History</button>
        <button type="button" role="menuitem" tabIndex={-1} aria-label="Browse commands and skills"
          disabled={authoringBlocked || !online || !api?.catalog} onClick={() => { returnFocusRef.current = "Browse commands and skills"; setView("catalog"); }}><Blocks size={16} aria-hidden="true" />Browse commands and skills</button>
        <button type="button" role="menuitem" tabIndex={-1} aria-label="Choose Pi model"
          disabled={authoringBlocked || !online || !api?.state || api.state.busy !== "idle"} onClick={() => { returnFocusRef.current = "Choose Pi model"; setView("model"); }}><Cpu size={16} aria-hidden="true" />Model</button>
        <button type="button" role="menuitem" tabIndex={-1} aria-label="Choose Pi thinking level"
          disabled={authoringBlocked || !online || !api?.state?.thinking_levels.length || api.state.busy !== "idle"}
          onClick={() => { returnFocusRef.current = "Choose Pi thinking level"; setView("thinking"); }}><Brain size={16} aria-hidden="true" />Thinking level</button>
        {PI_QUICK_ACTIONS.map(({ label, title, command, icon: Icon }) => <button key={label} type="button" role="menuitem" tabIndex={-1}
          aria-label={label} disabled={disabled || authoringBlocked || (command !== null && (!online || api?.state?.busy !== "idle"))}
          onClick={() => quickAction(piQuickActionParts(command))}><Icon size={16} aria-hidden="true" />{title}</button>)}
        {tools ? <button type="button" role="menuitem" tabIndex={-1} aria-label="Terminal keys and Reader"
          onClick={() => { returnFocusRef.current = "Terminal keys and Reader"; setView("tools"); }}><Keyboard size={16} aria-hidden="true" />Terminal keys and Reader</button> : null}
        {actionRecovery ? <button type="button" role="menuitem" tabIndex={-1} aria-label="Submit pending Pi action"
          disabled={disabled || actionPending} onClick={() => quickAction(["\r"])}><CornerDownLeft size={16} aria-hidden="true" />Submit pending action</button> : null}
        {actionPending ? <p role="status">Sending Pi action…</p> : null}
        </> : view === "tools" ? <>
          <button type="button" aria-label="Back to Composer helpers" onClick={() => setView("root")}><ChevronLeft size={16} aria-hidden="true" />Back</button>
          {tools}
        </> : view === "model" ? <>
          <button type="button" aria-label="Back to Composer helpers" onClick={() => setView("root")}><ChevronLeft size={16} aria-hidden="true" />Back</button>
          <PiModelPicker api={api} disabled={disabled || api?.state?.busy !== "idle"} embedded open
            onOpenChange={(next) => { if (!next) closeAndFocus(); }} />
        </> : view === "thinking" ? <>
          <button type="button" aria-label="Back to Composer helpers" onClick={() => setView("root")}><ChevronLeft size={16} aria-hidden="true" />Back</button>
          {api?.state?.thinking_levels.map((level) => <button type="button" key={level}
            aria-label={`Use thinking level ${level}`} aria-pressed={api.state?.thinking_level === level}
            disabled={pending || !online || disabled || api.state?.busy !== "idle"}
            onClick={() => {
              if (!api || pending || disabled || !online) return;
              const generation = generationRef.current;
              setPending(true);
              setError(null);
              void api.setThinkingLevel(level).then(() => {
                if (generation !== generationRef.current) return;
                setPending(false);
                closeAndFocus();
              }).catch((reason: unknown) => {
                if (generation !== generationRef.current) return;
                setPending(false);
                setError(reason instanceof Error ? reason.message : "Thinking change failed.");
              });
            }}>{level}</button>)}
          {pending ? <p role="status">Changing thinking level…</p> : null}
        </> : <>
          <button type="button" aria-label="Back to Composer helpers" onClick={() => setView("root")}><ChevronLeft size={16} aria-hidden="true" />Back</button>
          <input type="search" aria-label="Search commands and skills" placeholder="Search name, description, source"
            value={query} onChange={(event) => setQuery(event.target.value)} />
          {api?.catalog?.skills_note ? <p role="note">{api.catalog.skills_note}</p> : api?.capabilities.skills_catalog !== true ? <p role="note">Skills are unavailable on this Pi Bridge; commands remain available.</p> : null}
          <ul aria-label="Command and skill catalog">
            {catalogEntries.map((entry, index) => {
              const trigger = piCatalogTrigger(entry, entry.kind);
              return <li key={`${entry.kind}:${entry.name}:${index}`}>
                <button type="button" aria-label={`Insert ${trigger}`} onClick={() => onInsertCatalog(trigger)}>
                  <strong>{trigger}</strong><span>{entry.description}</span><small>{entry.kind} · {entry.source}</small>
                </button>
              </li>;
            })}
          </ul>
          {catalogEntries.length === 0 ? <p role="status">No matching commands or skills.</p> : null}
        </>}
        {error || actionError ? <p role="alert">{error ?? actionError}</p> : null}
        {api?.state?.busy !== "idle" && online ? <p role="note">Pi is {api?.state?.busy ?? "unavailable"}. Model, thinking and session actions require an idle session. Abort and authoring remain available.</p> : null}
        {!online ? <p role="status">Bridge offline. Prefix editing is available; autocomplete is unavailable.</p>
          : !filesAvailable ? <p role="status">File autocomplete is unavailable on this Pi Bridge.</p> : null}
      </div> : null}
    </div>
  );
}
