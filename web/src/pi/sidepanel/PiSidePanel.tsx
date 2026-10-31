import { PanelRight } from "lucide-react";
import type { BridgeHttpUrl } from "../../bridgeApi";
import { piComposerDeliveryParts } from "../../pi-mode/piComposerDelivery";
import { useId, useState } from "react";

import { usePiBridge } from "../PiBridgeContext";
import { piQuickActionParts } from "./piQuickActions";
import { PiSidePanelButtonManager } from "./PiSidePanelButtonManager";
import { defaultPiSidePanelButtons, type PiSidePanelAction } from "./piSidePanelButtons";
import { usePiSidePanelButtons } from "./usePiSidePanelButtons";
import { insertPiComposerText } from "./piComposerInsert";
import { piCatalogTrigger, piSidePanelEntries } from "./piSidePanelCatalog";
import { readRecentPiTriggers, rememberPiTrigger } from "./piSidePanelRecents";
import { PiModelPicker } from "../../pi-mode/PiModelPicker";
import "./pi-side-panel.css";

export type PiSidePanelContentProps = {
  bridgeId: string;
  paneId: string;
  disabled: boolean;
  httpUrl?: BridgeHttpUrl;
  onSend: (parts: string[], onDelivered?: (delivered: number, total: number) => void) => boolean;
  /** Lets the owning shell point a toggle's `aria-controls` at this body. */
  contentId?: string;
};

/**
 * The one Side Panel body: model, thinking, quick actions, chat log and the
 * searchable catalog with recents. The terminal aside and the Composer's
 * floating panel both render it, so the view and its rules cannot drift; only
 * the shell (inline aside vs. floating panel) differs.
 */
export function PiSidePanelContent({ bridgeId, paneId, disabled, httpUrl, onSend, contentId }: PiSidePanelContentProps) {
  const bridge = usePiBridge(paneId);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(readRecentPiTriggers);
  const [error, setError] = useState<string | null>(null);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const buttons = usePiSidePanelButtons(bridgeId, httpUrl);
  const state = bridge?.state;
  const online = bridge?.status === "online";
  const canActivate = (action: PiSidePanelAction) => {
    if (action.type === "prompt" && action.delivery === "insert") return true;
    if (disabled) return false;
    if (action.type === "builtin" && action.id !== "abort" && action.id !== "chat-log") return !online || !state || state.busy === "idle";
    if (action.type === "prompt" && online && state?.busy !== "idle") return false;
    return true;
  };
  const insert = (text: string) => {
    const result = insertPiComposerText(bridgeId, paneId, text);
    setError(result === "inserted" ? null : result === "blocked"
      ? "Insertion is blocked by pending or unresolved terminal input. Open the Composer to resolve it."
      : "The Composer draft is unavailable; nothing was inserted.");
    return result === "inserted";
  };
  const activate = (action: PiSidePanelAction) => {
    if (!canActivate(action)) return;
    setError(null);
    setDeliveryStatus(null);
    if (action.type === "prompt" && action.delivery === "insert") {
      insert(action.text);
      return;
    }
    const parts = action.type === "prompt" ? piComposerDeliveryParts(action.text)
      : action.id === "chat-log" ? ["\x1b[99;3u"]
      : piQuickActionParts(({ abort: null, compact: "/compact", "new-session": "/new", resume: "/resume" } as const)[action.id]);
    const accepted = onSend(parts, (delivered, total) => {
      if (delivered === total && total > 0) setDeliveryStatus("Action delivered to the terminal connection; Pi execution is not confirmed.");
      else if (delivered > 0) setError("Only part of the action reached the terminal. Open the Composer to resolve pending input without pasting again.");
      else setError("Action was not delivered. The Composer draft and attachments are unchanged.");
    });
    if (!accepted) setError("Action could not be queued. Open the Composer to resolve pending or manual input.");
  };
  const change = (request: Promise<void>) => {
    setError(null);
    void request.catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Pi change failed.");
    });
  };

  return (
    <div id={contentId} className="pi-side-panel-content">
      {online && state ? <>
        <div className="pi-side-panel-model">
          <span className="pi-side-panel-label">Model</span>
          <PiModelPicker api={bridge} disabled={disabled} />
        </div>
        <label>Thinking
          <select aria-label="Pi thinking level" value={state.thinking_level}
            onChange={(event) => { if (bridge) change(bridge.setThinkingLevel(event.target.value)); }}>
            {!state.thinking_levels.includes(state.thinking_level)
              ? <option value={state.thinking_level} disabled>{state.thinking_level}</option> : null}
            {state.thinking_levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
      </> : null}
      <PiSidePanelButtonManager
        model={buttons.state ?? defaultPiSidePanelButtons()}
        status={buttons.status === "saving" ? "loading" : buttons.status === "conflict" ? "error" : buttons.status}
        error={buttons.error}
        catalog={online ? bridge?.catalog ?? null : null}
        skillsEnabled={bridge?.capabilities.skills_catalog === true}
        onMutate={buttons.save}
        onActivate={activate}
        canActivate={canActivate}
        conflictContent={buttons.status === "conflict" ? <div role="region" aria-label="Resolve button conflict">
          <p>Another client changed these buttons. Your edits are preserved. Review the latest version before choosing whether to replace it.</p>
          {buttons.latest ? <><p>Latest configuration:</p><pre>{JSON.stringify(buttons.latest, null, 2)}</pre>
            <p>Your attempted configuration:</p><pre>{JSON.stringify(buttons.draft, null, 2)}</pre>
            <p>Replacing the latest configuration can discard the other client’s changes.</p>
            <button type="button" onClick={() => buttons.reconcile(buttons.latest!)}>Use latest configuration</button>
            <button type="button" onClick={() => { void buttons.saveReconciled().catch(() => {}); }}>Replace latest with my edits</button></>
            : <button type="button" onClick={buttons.refresh}>Retry loading latest</button>}
        </div> : null}
      />
      {buttons.status === "error" ? <button type="button" onClick={buttons.refresh}>Retry loading buttons</button> : null}
      {error ? <p role="alert">{error}</p> : null}
      {deliveryStatus ? <p role="status">{deliveryStatus}</p> : null}
      {online && bridge?.catalog ? (
        <section aria-label="Commands and skills" className="pi-side-panel-catalog">
          <label>Commands and skills
            <input type="search" aria-label="Search commands and skills" value={query}
              onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, source" />
          </label>
          {bridge.catalog.skills_note ? <p role="note">{bridge.catalog.skills_note}</p> : null}
          <ul>
            {piSidePanelEntries(bridge.catalog, bridge.capabilities.skills_catalog === true, query)
              .map((entry, index) => ({ entry, index }))
              .sort(({ entry: a }, { entry: b }) => {
                const rank = (trigger: string) => {
                  const index = recents.indexOf(trigger);
                  return index < 0 ? recents.length : index;
                };
                return rank(piCatalogTrigger(a, a.kind)) - rank(piCatalogTrigger(b, b.kind));
              }).map(({ entry, index }) => {
              const trigger = piCatalogTrigger(entry, entry.kind);
              return <li key={`${entry.kind}:${entry.name}:${index}`}>
                <button type="button" aria-label={`Insert ${trigger}`}
                  onClick={() => {
                    if (insert(trigger)) setRecents(rememberPiTrigger(trigger, recents));
                  }}>
                  <strong>{trigger}</strong>
                  <span>{entry.description}</span>
                  <small>{entry.kind} · {entry.source}</small>
                </button>
              </li>;
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type PiSidePanelProps = {
  bridgeId: string;
  paneId: string;
  disabled: boolean;
  httpUrl?: BridgeHttpUrl;
  onSend: PiSidePanelContentProps["onSend"];
};

/** Terminal aside: a collapsed icon that expands into the shared body. */
export function PiSidePanel({ bridgeId, paneId, disabled, httpUrl, onSend }: PiSidePanelProps) {
  const bridge = usePiBridge(paneId);
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const online = bridge?.status === "online";

  return (
    <aside className="pi-side-panel" data-open={open} aria-label="Pi Side Panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !(event.target as Element).closest('.pi-model-picker[data-open="true"]')) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          event.currentTarget.querySelector<HTMLButtonElement>(":scope > button")?.focus();
        }
      }}>
      <button type="button" aria-label="Toggle Pi Side Panel" title="Toggle Pi Side Panel"
        aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}>
        <PanelRight size={18} aria-hidden="true" />
        <span>Side Panel</span>
        {!online ? <i className="pi-side-panel-dot" aria-hidden="true" /> : null}
      </button>
      {!online ? <p role="status" className="pi-side-panel-status">Bridge Offline</p> : null}
      {open ? (
        <PiSidePanelContent
          bridgeId={bridgeId}
          paneId={paneId}
          disabled={disabled}
          httpUrl={httpUrl}
          onSend={onSend}
          contentId={contentId}
        />
      ) : null}
    </aside>
  );
}
