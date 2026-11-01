import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./FileEditor.css";

/** Parent owns this draft and its bridge/root/file identity, including persistence. */
export interface FileDraft {
  content: string;
  baseContent: string;
  baseRevision: string;
}

export type FileSaveResult =
  | { ok: true; revision: string }
  | { ok: false; kind: "conflict" | "error"; message: string };

export interface FileEditorProps {
  content: string;
  revision: string;
  draft: FileDraft;
  availability: "available" | "deleted" | "disconnected";
  onDraftChange: (draft: FileDraft) => void;
  onSave?: (content: string, revision: string) => Promise<FileSaveResult>;
}

/** Mount with a parent-owned key for each file identity. Closing and conflict resolution belong to the parent. */
export function FileEditor({ content, revision, draft, availability, onDraftChange, onSave }: FileEditorProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const changeRef = useRef(onDraftChange);
  changeRef.current = onDraftChange;
  const observed = useRef<{ content: string; revision: string } | null>(null);
  const inFlight = useRef<{ content: string; revision: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const previous = observed.current;
    if (previous && previous.content === content && previous.revision === revision) return;
    observed.current = { content, revision };
    const current = draftRef.current;
    const dirty = current.content !== current.baseContent ||
      (inFlight.current !== null && current.content !== inFlight.current.content);
    if (dirty) {
      if (inFlight.current && content === inFlight.current.content && revision !== inFlight.current.revision) return;
      if (content !== current.baseContent || revision !== current.baseRevision) setConflict(true);
    } else {
      const next = { content, baseContent: content, baseRevision: revision };
      draftRef.current = next;
      changeRef.current(next);
      setConflict(false);
    }
  }, [content, revision]);

  async function save() {
    const current = draftRef.current;
    if (!onSave || availability !== "available" || conflict || inFlight.current || current.content === current.baseContent) return;
    const request = { content: current.content, revision: current.baseRevision };
    inFlight.current = request;
    setSaving(true);
    setError("");
    try {
      const result = await onSave(request.content, request.revision);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.message);
        if (result.kind === "conflict") setConflict(true);
        // A server update provisionally treated as this save's echo was not confirmed.
        if (observed.current && (observed.current.content !== current.baseContent || observed.current.revision !== current.baseRevision)) setConflict(true);
      } else {
        const next = { ...draftRef.current, baseContent: request.content, baseRevision: result.revision };
        draftRef.current = next;
        changeRef.current(next);
        const latest = observed.current;
        if (latest && (latest.content !== content || latest.revision !== revision) &&
            (latest.content !== request.content || latest.revision !== result.revision)) setConflict(true);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : "Save failed");
        if (observed.current && (observed.current.content !== current.baseContent || observed.current.revision !== current.baseRevision)) setConflict(true);
      }
    } finally {
      inFlight.current = null;
      if (mounted.current) setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  const dirty = draft.content !== draft.baseContent;
  const status = availability !== "available" ? `File ${availability}` : conflict ? "Conflict: file changed externally" : saving ? "Saving" : dirty ? "Unsaved changes" : "Saved";
  return <div className="file-editor" onKeyDown={onKeyDown}>
    <div className="file-editor-controls">
      <button type="button" onClick={() => setEditing(!editing)}>{editing ? "Read only" : "Edit"}</button>
      {onSave && <button type="button" disabled={!dirty || saving || conflict || availability !== "available"} onClick={() => void save()}>Save</button>}
      <span role="status" aria-live="polite">{status}</span>
    </div>
    {error && <p role="alert">{error}</p>}
    <textarea aria-label="File contents" readOnly={!editing} value={draft.content} onChange={(event) => {
      const next = { ...draftRef.current, content: event.currentTarget.value };
      draftRef.current = next;
      onDraftChange(next);
    }} />
  </div>;
}
