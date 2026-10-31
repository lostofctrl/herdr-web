import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { PiSidePanelContent, type PiSidePanelContentProps } from "../pi/sidepanel/PiSidePanel";
import "../pi/sidepanel/pi-side-panel.css";
import "./pi-composer-side-panel.css";

export type PiComposerSidePanelProps = {
  bridgeId: string;
  paneId: string;
  disabled: boolean;
  httpUrl?: PiSidePanelContentProps["httpUrl"];
  onSend: PiSidePanelContentProps["onSend"];
  onClose: () => void;
  /** The Composer control the panel floats from; clicking it must not dismiss. */
  anchorRef: RefObject<HTMLElement | null>;
};

type Bounds = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

const PANEL_WIDTH = 320;
const PANEL_GAP = 8;
const PANEL_MAX_HEIGHT = 420;

/**
 * The Side Panel floating over the Composer. It renders the same body as the
 * terminal aside through `PiSidePanelContent`; only placement and dismissal are
 * Composer-owned, so a pane keeps one Side Panel view and one set of rules
 * (catalog picks insert into the draft, quick actions use the PTY path).
 */
export function PiComposerSidePanel({
  bridgeId,
  paneId,
  disabled,
  httpUrl,
  onSend,
  onClose,
  anchorRef,
}: PiComposerSidePanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<Bounds>({ left: PANEL_GAP, top: PANEL_GAP, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT });

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = Math.min(PANEL_WIDTH, (viewport?.width ?? window.innerWidth) - PANEL_GAP * 2);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      // Prefer the space above the Composer; fall back below it in the open
      // terminal above a docked Composer.
      const above = rect.top - top - PANEL_GAP;
      const below = bottom - rect.bottom - PANEL_GAP;
      const height = Math.min(PANEL_MAX_HEIGHT, Math.max(96, Math.max(above, below)));
      setBounds({
        left: Math.max(left + PANEL_GAP, Math.min(rect.right - width, left + (viewport?.width ?? window.innerWidth) - width - PANEL_GAP)),
        ...(above >= below ? { bottom: window.innerHeight - rect.top + PANEL_GAP } : { top: rect.bottom + PANEL_GAP }),
        width,
        maxHeight: height,
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
  }, [anchorRef]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target as Node)) return;
      // The trigger owns its own toggle; dismissing here would close and reopen.
      if (anchorRef.current?.contains(target as Node)) return;
      onClose();
    };
    // Escape closes the panel before it reaches the Composer, so one press
    // dismisses the surface on top instead of the whole Composer.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Element | null;
      // The model picker inside the panel owns Escape while it is open.
      if (target?.closest('.pi-model-picker[data-open="true"]') || rootRef.current?.querySelector(".pi-button-manager-dialog")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      ref={rootRef}
      className="pi-composer-side-panel"
      role="dialog"
      aria-modal="false"
      aria-label="Pi Side Panel"
      style={{
        left: `${bounds.left}px`,
        width: `${bounds.width}px`,
        maxHeight: `${bounds.maxHeight}px`,
        ...(bounds.top === undefined ? { bottom: `${bounds.bottom}px` } : { top: `${bounds.top}px` }),
      }}
    >
      <div className="pi-composer-side-panel-header">
        <span>Side Panel</span>
        <button type="button" aria-label="Close Pi Side Panel" title="Close Pi Side Panel" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <PiSidePanelContent bridgeId={bridgeId} paneId={paneId} disabled={disabled} httpUrl={httpUrl} onSend={onSend} />
    </div>
  );
}
