import { PanelRight } from "lucide-react";
import { useId, useState } from "react";

import { usePiBridge } from "../PiBridgeContext";
import { PI_ESCAPE_KEY } from "../piKeys";
import { piComposerDeliveryParts } from "../../pi-mode/piComposerDelivery";
import { insertPiComposerText } from "./piComposerInsert";
import { piCatalogTrigger, piSidePanelEntries } from "./piSidePanelCatalog";
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
  const modelKey = (provider: string, id: string) => JSON.stringify([provider, id]);
  const change = (request: Promise<void>) => {
    setError(null);
    void request.catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Pi change failed.");
    });
  };

  return (
    <aside className="pi-side-panel" data-open={open} aria-label="Pi Side Panel">
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
            <label>Model
              <select aria-label="Pi model"
                value={state.model ? modelKey(state.model.provider, state.model.id) : ""}
                onChange={(event) => {
                  const model = state.models.find((item) => modelKey(item.provider, item.id) === event.target.value);
                  if (model && bridge) change(bridge.setModel(model.provider, model.id));
                }}>
                <option value="" disabled>Select model</option>
                {state.model && !state.models.some((model) =>
                  model.provider === state.model?.provider && model.id === state.model.id,
                ) ? <option value={modelKey(state.model.provider, state.model.id)} disabled>
                    {state.model.id} · {state.model.provider}
                  </option> : null}
                {state.models.map((model) => <option key={modelKey(model.provider, model.id)}
                  value={modelKey(model.provider, model.id)}>{model.label} · {model.provider}</option>)}
              </select>
            </label>
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
            <button type="button" aria-label="Abort Pi" disabled={disabled}
              onClick={() => onSend([PI_ESCAPE_KEY])}>Abort</button>
            {[
              ["Compact Pi session", "Compact", "/compact"],
              ["New Pi session", "New session", "/new"],
              ["Resume Pi session", "Resume", "/resume"],
            ].map(([label, title, command]) => (
              <button key={command} type="button" aria-label={label} disabled={disabled}
                onClick={() => onSend(piComposerDeliveryParts(command))}>{title}</button>
            ))}
          </section>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}
