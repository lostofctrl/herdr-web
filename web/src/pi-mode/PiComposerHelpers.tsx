import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./pi-composer-helpers.css";

export type PiComposerHelper = "slash" | "file" | "shell";

type Props = {
  open: boolean;
  disabled: boolean;
  online: boolean;
  filesAvailable: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (kind: PiComposerHelper) => void;
};

/** Authoring only: none of these actions delivers terminal input. */
export function PiComposerHelpers({ open, disabled, online, filesAvailable, onOpen, onClose, onPick }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
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
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node)) return;
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

  const closeAndFocus = () => { onClose(); triggerRef.current?.focus(); };
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
      {open ? <div ref={menuRef} id={id} role="menu" aria-label="Composer helpers"
        className="pi-composer-helpers-menu" style={bounds}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); return; }
          if (event.key === "Tab") { closeAndFocus(); return; }
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowDown" ? (index + 1) % buttons.length
            : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : null;
          if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
        }}>
        {([ ["slash", "/ Commands and skills"], ["file", "@ Files and paths"], ["shell", "! Shell command"] ] as const).map(([kind, label]) => (
          <button key={kind} type="button" role="menuitem" tabIndex={-1} data-helper={kind}
            onClick={() => onPick(kind)}>{label}</button>
        ))}
        {!online ? <p role="status">Bridge offline. Prefix editing is available; autocomplete is unavailable.</p>
          : !filesAvailable ? <p role="status">File autocomplete is unavailable on this Pi Bridge.</p> : null}
      </div> : null}
    </div>
  );
}
