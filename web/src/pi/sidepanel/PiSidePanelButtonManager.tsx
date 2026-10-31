import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Archive, Bookmark, CircleStop, Code, History, MessageSquareText, Play, Plus, Send, Star, Terminal, Zap, type LucideIcon } from "lucide-react";
import type { PiCatalog } from "../piProtocol";
import { piCatalogTrigger, piSidePanelEntries } from "./piSidePanelCatalog";
import { parsePiSidePanelButtons, type PiSidePanelAction, type PiSidePanelButton, type PiSidePanelButtons, type PiSidePanelBuiltin, type PiSidePanelIcon } from "./piSidePanelButtons";

export type ButtonManagerBuiltinId = PiSidePanelBuiltin;
export type ButtonManagerIconName = Extract<PiSidePanelIcon, { type: "lucide" }>["name"];
export type ButtonManagerAction = PiSidePanelAction;
export type ButtonManagerButton = PiSidePanelButton;
export type ButtonManagerModel = PiSidePanelButtons;
export type PiSidePanelButtonManagerProps = {
  model: ButtonManagerModel | null;
  status: "loading" | "ready" | "error" | "unsupported";
  error: string | null;
  catalog: PiCatalog | null;
  skillsEnabled: boolean;
  onMutate: (model: ButtonManagerModel) => Promise<void>;
  onActivate: (action: ButtonManagerAction, id: string) => void;
  canActivate?: (action: ButtonManagerAction) => boolean;
  conflictContent?: ReactNode;
};

const icons: Record<ButtonManagerIconName, LucideIcon> = {
  "circle-stop": CircleStop, archive: Archive, plus: Plus, history: History, "message-square-text": MessageSquareText,
  star: Star, zap: Zap, terminal: Terminal, code: Code, bookmark: Bookmark, play: Play, send: Send,
};
const builtins: ButtonManagerButton[] = [
  { id: "abort", title: "Abort Pi", icon: { type: "lucide", name: "circle-stop" }, action: { type: "builtin", id: "abort" } },
  { id: "compact", title: "Compact Pi session", icon: { type: "lucide", name: "archive" }, action: { type: "builtin", id: "compact" } },
  { id: "new-session", title: "New Pi session", icon: { type: "lucide", name: "plus" }, action: { type: "builtin", id: "new-session" } },
  { id: "resume", title: "Resume Pi session", icon: { type: "lucide", name: "history" }, action: { type: "builtin", id: "resume" } },
  { id: "chat-log", title: "Open chat log", icon: { type: "lucide", name: "message-square-text" }, action: { type: "builtin", id: "chat-log" } },
];

type Draft = { id: string | null; title: string; iconType: "lucide" | "glyph"; iconName: ButtonManagerIconName; glyph: string; actionType: "builtin" | "prompt"; builtin: ButtonManagerBuiltinId; prompt: string; delivery: "insert" | "send" };
const newDraft = (): Draft => ({ id: null, title: "", iconType: "lucide", iconName: "star", glyph: "", actionType: "builtin", builtin: "abort", prompt: "", delivery: "insert" });
function draftFrom(button: ButtonManagerButton): Draft {
  return { ...newDraft(), id: button.id, title: button.title, iconType: button.icon.type,
    iconName: button.icon.type === "lucide" ? button.icon.name : "star", glyph: button.icon.type === "glyph" ? button.icon.text : "",
    actionType: button.action.type, builtin: button.action.type === "builtin" ? button.action.id : "abort",
    prompt: button.action.type === "prompt" ? button.action.text : "", delivery: button.action.type === "prompt" ? button.action.delivery : "insert" };
}
function Icon({ icon }: { icon: ButtonManagerButton["icon"] }) {
  if (icon.type === "glyph") return <span aria-hidden="true">{icon.text}</span>;
  const Component = icons[icon.name];
  return Component ? <Component size={18} aria-hidden="true" /> : null;
}

export function PiSidePanelButtonManager({ model, status, error, catalog, skillsEnabled, onMutate, onActivate, canActivate = () => true, conflictContent }: PiSidePanelButtonManagerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ButtonManagerButton | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<string | null>(null);
  const editingRevision = useRef<number | null>(null);
  const wasSubdialog = useRef(false);
  const entries = [...builtins, ...(model?.buttons ?? [])];
  const available = status === "ready" && model !== null && !busy;
  const subdialog = draft !== null || deleting !== null;

  useEffect(() => {
    if (!open) return;
    const returnTarget = wasSubdialog.current && !subdialog
      ? [...(dialogRef.current?.querySelectorAll<HTMLElement>("[data-return-focus]") ?? [])].find((element) => element.dataset.returnFocus === returnRef.current)
      : null;
    (returnTarget ?? dialogRef.current)?.focus();
    wasSubdialog.current = subdialog;
  }, [open, subdialog]);

  function close() { setOpen(false); setDraft(null); setDeleting(null); setLocalError(null); wasSubdialog.current = false; triggerRef.current?.focus(); }
  function back() { setDraft(null); setDeleting(null); setLocalError(null); }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) { if (subdialog) back(); else close(); } return; }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function change(next: ButtonManagerModel): Promise<boolean> {
    setBusy(true); setLocalError(null);
    try { await onMutate(parsePiSidePanelButtons(next)); return true; }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : "Could not save buttons."); return false; }
    finally { setBusy(false); }
  }
  function toggle(id: string) {
    if (!model || !available) return;
    void change({ ...model, pinned: model.pinned.includes(id) ? model.pinned.filter((item) => item !== id) : [...model.pinned, id] });
  }
  function edit(button: ButtonManagerButton | null, source: HTMLElement) {
    returnRef.current = source.dataset.returnFocus ?? null; editingRevision.current = model?.revision ?? null;
    setLocalError(null); setDraft(button ? draftFrom(button) : newDraft());
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!model || !draft || !available) return;
    if (model.revision !== editingRevision.current) { setLocalError("Buttons changed while you were editing. Copy your changes before closing and reopen the editor."); return; }
    const title = draft.title.trim();
    // These expressions intentionally reject terminal controls and bidi overrides.
    // eslint-disable-next-line no-control-regex
    if (!title || Array.from(title).length > 80 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(title)) { setLocalError("Title must be 1–80 characters without control characters."); return; }
    // eslint-disable-next-line no-control-regex
    if (draft.iconType === "glyph" && (!draft.glyph.trim() || Array.from(draft.glyph).length > 16 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(draft.glyph))) { setLocalError("Glyph must be 1–16 characters without control characters."); return; }
    // eslint-disable-next-line no-control-regex
    if (draft.actionType === "prompt" && (!draft.prompt.trim() || new TextEncoder().encode(draft.prompt).length > 8192 || /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(draft.prompt))) { setLocalError("Prompt must be nonempty, at most 8192 UTF-8 bytes, and contain no unsafe control characters."); return; }
    if (!draft.id && model.buttons.length >= 64) { setLocalError("A maximum of 64 custom buttons is allowed."); return; }
    if (draft.id && !model.buttons.some((button) => button.id === draft.id)) { setLocalError("This button no longer exists. Copy your changes before closing."); return; }
    let id = draft.id;
    if (!id) {
      id = `custom-${crypto.randomUUID()}`;
      if (entries.some((entry) => entry.id === id)) { setLocalError("Could not create a unique button ID. Try again."); return; }
    }
    const button: ButtonManagerButton = { id, title, icon: draft.iconType === "glyph" ? { type: "glyph", text: draft.glyph } : { type: "lucide", name: draft.iconName }, action: draft.actionType === "builtin" ? { type: "builtin", id: draft.builtin } : { type: "prompt", text: draft.prompt, delivery: draft.delivery } };
    const buttons = draft.id ? model.buttons.map((item) => item.id === draft.id ? button : item) : [...model.buttons, button];
    if (await change({ ...model, buttons })) back();
  }
  async function remove() {
    if (!model || !deleting || !available) return;
    if (model.revision !== editingRevision.current) { setLocalError("Buttons changed while you were editing. Close and review the latest list before deleting."); return; }
    if (await change({ ...model, buttons: model.buttons.filter((item) => item.id !== deleting.id), pinned: model.pinned.filter((id) => id !== deleting.id) })) back();
  }

  return <section className="pi-button-manager" aria-label="Pi buttons">
    <div className="pi-side-panel-actions" aria-label="Pi quick actions">
      {model?.pinned.map((id) => {
        const button = entries.find((entry) => entry.id === id);
        return button ? <button key={id} type="button" aria-label={button.title} title={button.title} disabled={(status !== "ready" && button.id.startsWith("custom-")) || !canActivate(button.action)} onClick={() => onActivate(button.action, button.id)}><Icon icon={button.icon} /></button> : null;
      })}
      <button ref={triggerRef} type="button" aria-label="Manage Pi buttons" title="Manage Pi buttons" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>⋯</button>
    </div>
    {status === "loading" ? <p role="status">Loading buttons…</p> : null}
    {status === "unsupported" ? <p role="status">Custom buttons are not supported by this bridge.</p> : null}
    {error && !open ? <p role="alert">{error}</p> : null}
    {open ? <div className="pi-button-manager-dialog" role="dialog" aria-modal="true" aria-label={draft ? (draft.id ? "Edit button" : "Add button") : deleting ? "Delete button" : "Manage Pi buttons"} tabIndex={-1} ref={dialogRef} onKeyDown={keyDown}>
      <h3>{draft ? (draft.id ? "Edit button" : "Add button") : deleting ? "Delete button" : "Manage Pi buttons"}</h3>
      <p>The terminal editor may contain unseen typed text. Prompt actions can insert or send text into it. Shared storage is not secret; do not store sensitive information.</p>
      {error ? <p role="alert">{error}</p> : null}
      {localError && localError !== error ? <p role="alert">{localError}</p> : null}
      {conflictContent}
      {draft ? <form onSubmit={(event) => void save(event)} className="pi-button-manager-form">
        <label>Title<input aria-label="Title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>Icon type<select aria-label="Icon type" value={draft.iconType} onChange={(event) => setDraft({ ...draft, iconType: event.target.value as Draft["iconType"] })}><option value="lucide">Lucide icon</option><option value="glyph">Text glyph</option></select></label>
        {draft.iconType === "lucide" ? <label>Icon<select aria-label="Icon" value={draft.iconName} onChange={(event) => setDraft({ ...draft, iconName: event.target.value as ButtonManagerIconName })}>{Object.keys(icons).map((name) => <option key={name} value={name}>{name}</option>)}</select></label> : <label>Glyph<input aria-label="Glyph" value={draft.glyph} onChange={(event) => setDraft({ ...draft, glyph: event.target.value })} /></label>}
        <label>Action<select aria-label="Action" value={draft.actionType} onChange={(event) => setDraft({ ...draft, actionType: event.target.value as Draft["actionType"] })}><option value="builtin">Built-in action</option><option value="prompt">Prompt</option></select></label>
        {draft.actionType === "builtin" ? <label>Built-in action<select aria-label="Built-in action" value={draft.builtin} onChange={(event) => setDraft({ ...draft, builtin: event.target.value as ButtonManagerBuiltinId })}>{builtins.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : <>
          <label>Command or skill<select aria-label="Command or skill" value="" onChange={(event) => { if (event.target.value) setDraft({ ...draft, prompt: event.target.value + (draft.prompt ? ` ${draft.prompt}` : "") }); }}><option value="">Choose from live catalog</option>{catalog ? piSidePanelEntries(catalog, skillsEnabled, "").map((entry, index) => { const trigger = piCatalogTrigger(entry, entry.kind); return <option key={`${entry.kind}:${entry.name}:${index}`} value={trigger}>{trigger} — {entry.description}</option>; }) : null}</select></label>
          <label>Prompt<textarea aria-label="Prompt" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
          <label>Delivery<select aria-label="Delivery" value={draft.delivery} onChange={(event) => setDraft({ ...draft, delivery: event.target.value as Draft["delivery"] })}><option value="insert">Insert</option><option value="send">Send</option></select></label>
        </>}
        <div className="pi-button-manager-controls"><button type="button" onClick={back} disabled={busy}>Cancel</button><button type="submit" disabled={!available}>Save button</button></div>
      </form> : deleting ? <><p>Delete {deleting.title}? This cannot be undone.</p><div className="pi-button-manager-controls"><button type="button" onClick={back} disabled={busy}>Cancel deletion</button><button type="button" onClick={() => void remove()} disabled={!available}>Confirm delete</button></div></> : <>
        <ul className="pi-button-manager-list">{entries.map((button, index) => <li key={button.id}><button type="button" className="pi-button-manager-name" aria-label={`Run ${button.title}`} disabled={(status !== "ready" && button.id.startsWith("custom-")) || !canActivate(button.action)} onClick={() => onActivate(button.action, button.id)}><Icon icon={button.icon} />{button.title}</button><div className="pi-button-manager-controls"><button type="button" disabled={!available} aria-label={`${model?.pinned.includes(button.id) ? "Unpin" : "Pin"} ${button.title}`} onClick={() => toggle(button.id)}>{model?.pinned.includes(button.id) ? "Unpin" : "Pin"}</button>{index >= builtins.length ? <><button type="button" disabled={!available} aria-label={`Edit ${button.title}`} data-return-focus={`edit:${button.id}`} onClick={(event) => edit(button, event.currentTarget)}>Edit</button><button type="button" disabled={!available} aria-label={`Delete ${button.title}`} data-return-focus={`delete:${button.id}`} onClick={(event) => { returnRef.current = event.currentTarget.dataset.returnFocus ?? null; editingRevision.current = model?.revision ?? null; setDeleting(button); setLocalError(null); }}>Delete</button></> : null}</div></li>)}</ul>
        <div className="pi-button-manager-controls"><button type="button" disabled={!available || (model?.buttons.length ?? 0) >= 64} data-return-focus="add" onClick={(event) => edit(null, event.currentTarget)}>Add button</button><button type="button" onClick={close}>Close</button></div>
      </>}
    </div> : null}
  </section>;
}
