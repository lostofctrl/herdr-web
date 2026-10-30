import { PanelRight } from "lucide-react";
import { useId, useState } from "react";

import { usePiBridge } from "../PiBridgeContext";
import { PI_QUICK_ACTIONS, piQuickActionParts } from "./piQuickActions";
import { insertPiComposerText } from "./piComposerInsert";
import { piCatalogTrigger, piSidePanelEntries } from "./piSidePanelCatalog";
import { PiModelPicker } from "../../pi-mode/PiModelPicker";
import "./pi-side-panel.css";

type PiSidePanelProps = {
  bridgeId: string;
  paneId: string;
  disabled: boolean;
  onSend: (parts: string[]) => boolean;
};

export function PiSidePanel({ bridgeId, paneId, disabled, onSend }: PiSidePanelProps) {
  const bridge = usePiBridge(paneId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contentId = useId();
  const state = bridge?.state;
  const online = bridge?.status === "online";
  const change = (request: Promise<void>) => {
    setError(null);
    void request.catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Pi change failed.");
    });
  };

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
          {online && bridge?.catalog ? (
            <section aria-label="Commands and skills" className="pi-side-panel-catalog">
              <label>Commands and skills
                <input type="search" aria-label="Search commands and skills" value={query}
                  onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, source" />
              </label>
              {bridge.catalog.skills_note ? <p role="note">{bridge.catalog.skills_note}</p> : null}
              <ul>
                {piSidePanelEntries(bridge.catalog, bridge.capabilities.skills_catalog === true, query).map((entry, index) => {
                  const trigger = piCatalogTrigger(entry, entry.kind);
                  return <li key={`${entry.kind}:${entry.name}:${index}`}>
                    <button type="button" aria-label={`Insert ${trigger}`}
                      onClick={() => insertPiComposerText(bridgeId, paneId, trigger)}>
                      <strong>{trigger}</strong>
                      <span>{entry.description}</span>
                      <small>{entry.kind} · {entry.source}</small>
                    </button>
                  </li>;
                })}
              </ul>
            </section>
          ) : null}
          <section aria-label="Pi quick actions" className="pi-side-panel-actions">
            {PI_QUICK_ACTIONS.map(({ label, title, command }) => (
              <button key={label} type="button" aria-label={label} disabled={disabled}
                onClick={() => onSend(piQuickActionParts(command))}>{title}</button>
            ))}
          </section>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}
