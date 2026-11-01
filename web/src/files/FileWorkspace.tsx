import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileEditor, type FileDraft, type FileSaveResult } from "./FileEditor";
import { FileExplorer, type FileExplorerEntry } from "./FileExplorer";
import { InertMarkdown } from "./InertMarkdown";
import "./FileWorkspace.css";

/** Legacy drafts without a trustworthy base remain read-only until recovered by the owner. */
export type FileWorkspaceDraft = (FileDraft & { needsRecovery?: false }) | { content: string; needsRecovery: true };

export type FileWorkspaceEntry = FileExplorerEntry;

export interface FileWorkspaceProps {
  /** Unique for the exact live bridge/root/capability generation; never reuse after invalidation. */
  bindingKey: string;
  /** Callbacks must be bound to that exact generation and independently resolve paths safely; link hints may be stale. */
  list: (path: string) => Promise<FileWorkspaceEntry[]>;
  read: (path: string) => Promise<{ content: string; revision: string }>;
  save: (path: string, content: string, revision: string) => Promise<FileSaveResult>;
  /** Parent scopes and persists drafts by durable bridge/root/path identity, including both base fields. */
  drafts: Readonly<Record<string, FileWorkspaceDraft | undefined>>;
  onDraftChange: (path: string, draft: FileDraft) => void;
  /** Mutations are optional; each one must be bound to the same live generation as the other callbacks. */
  createFile?: (path: string) => Promise<void>;
  createDirectory?: (path: string) => Promise<void>;
  rename?: (path: string, destination: string) => Promise<void>;
  copy?: (path: string, destination: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  /** Owner moves or closes its tab and re-keys persisted drafts after a successful mutation. */
  onPathRenamed?: (from: string, to: string) => void;
  onPathRemoved?: (path: string) => void;
  onPathCopied?: (from: string, to: string) => void;
  offline?: boolean;
  storageWarning?: string;
  conflictWarning?: string;
}

/** Names typed by a user are single root-relative components; the bridge revalidates every path. */
export function validEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

type ReadResult = { attempt: number; content: string; revision: string; error?: never } |
  { attempt: number; error: string; deleted: boolean; content?: never; revision?: never };

function FilePanel({ path, read, save, rename, copy, remove, onPathRenamed, onPathRemoved, onPathCopied, draft, onDraftChange, offline, isCurrent }: {
  path: string; read: FileWorkspaceProps["read"]; save: FileWorkspaceProps["save"];
  rename: FileWorkspaceProps["rename"]; copy: FileWorkspaceProps["copy"]; remove: FileWorkspaceProps["remove"];
  onPathRenamed: FileWorkspaceProps["onPathRenamed"]; onPathRemoved: FileWorkspaceProps["onPathRemoved"];
  onPathCopied: FileWorkspaceProps["onPathCopied"];
  draft: FileWorkspaceDraft | undefined; onDraftChange: FileWorkspaceProps["onDraftChange"]; offline: boolean; isCurrent: () => boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copying, setCopying] = useState(false);
  const [newName, setNewName] = useState("");
  const [copyName, setCopyName] = useState("");
  const [busy, setBusy] = useState(false);
  const liveOperation = useRef(true);
  useEffect(() => { liveOperation.current = true; return () => { liveOperation.current = false; }; }, []);
  const run = useCallback(async (operation: () => Promise<void>, done: () => void) => {
    setBusy(true); setOperationError(null);
    try { await operation(); if (liveOperation.current && isCurrent()) done(); }
    catch (error) { if (liveOperation.current && isCurrent()) setOperationError(error instanceof Error ? error.message : "File operation failed"); }
    finally { if (liveOperation.current) { setBusy(false); setRenaming(false); setConfirmingDelete(false); } }
  }, [isCurrent]);
  const [result, setResult] = useState<ReadResult | null>(null);
  const live = useRef(false);
  const requestGeneration = useRef(0);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useLayoutEffect(() => {
    requestGeneration.current += 1;
    return () => { requestGeneration.current += 1; };
  }, [attempt, offline, read, save]);
  useEffect(() => {
    let current = true;
    const generation = requestGeneration.current;
    const valid = () => current && live.current && isCurrent() && requestGeneration.current === generation;
    if (!offline) {
      Promise.resolve().then(() => valid() ? read(path) : null).then(
        (value) => { if (valid() && value) setResult({ attempt, ...value }); },
        (error: unknown) => {
          if (!valid()) return;
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          setResult({ attempt, error: error instanceof Error ? error.message : "Unable to read file", deleted: code === "not_found" });
        },
      );
    }
    return () => { current = false; };
  }, [path, read, attempt, offline, isCurrent]);
  const visible = !offline && result?.attempt === attempt ? result : null;
  const error = visible && "error" in visible ? visible : null;
  const loaded = visible && "content" in visible && visible.content !== undefined ? visible : null;
  const recovery = draft?.needsRecovery === true ? draft : undefined;
  const currentDraft = recovery ? undefined : (draft as FileDraft | undefined) ?? (loaded ? { content: loaded.content, baseContent: loaded.content, baseRevision: loaded.revision } : undefined);
  const availability = offline || error ? (error && "deleted" in error && error.deleted ? "deleted" : "disconnected") : "available";
  async function saveCurrent(content: string, revision: string): Promise<FileSaveResult> {
    const generation = requestGeneration.current;
    const result = await save(path, content, revision);
    if (!live.current || !isCurrent() || requestGeneration.current !== generation) throw new Error("File selection or request changed");
    return result;
  }
  return <section className="file-workspace-file" aria-label={`File: ${path}`}>
    <div className="file-workspace-heading"><h2>{path}</h2><button type="button" disabled={offline} onClick={() => setAttempt((value) => value + 1)}>{error ? "Retry read" : "Refresh file"}</button></div>
    {remove && <button type="button" disabled={offline || busy} onClick={() => setConfirmingDelete(true)}>Delete</button>}
    {rename && <button type="button" disabled={offline || busy} onClick={() => { setRenaming(true); setNewName("") }}>Rename</button>}
    {copy && <button type="button" disabled={offline || busy} onClick={() => { setCopying(true); setCopyName("") }}>Copy file</button>}
    {copying && copy && <form onSubmit={(event) => { event.preventDefault(); if (!validEntryName(copyName)) { setOperationError("Enter one file name without slashes"); return; } void run(() => copy(path, copyName), () => { setCopying(false); onPathCopied?.(path, copyName); }); }}>
      <input aria-label="Copy destination" value={copyName} onChange={(event) => setCopyName(event.target.value)} disabled={busy} />
      <button type="submit" disabled={busy}>Confirm copy</button>
      <button type="button" disabled={busy} onClick={() => setCopying(false)}>Cancel copy</button>
    </form>}
    {renaming && rename && <form onSubmit={(event) => { event.preventDefault(); if (!validEntryName(newName)) { setOperationError("Enter one file name without slashes"); return; } void run(() => rename(path, newName), () => onPathRenamed?.(path, newName)); }}>
      <input aria-label="New name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={busy} />
      <button type="submit" disabled={busy}>Confirm rename</button>
      <button type="button" disabled={busy} onClick={() => setRenaming(false)}>Cancel rename</button>
    </form>}
    {confirmingDelete && remove && <p role="group" aria-label="Confirm delete">Delete {path}? <button type="button" disabled={busy} onClick={() => void run(() => remove(path), () => onPathRemoved?.(path))}>Confirm delete</button><button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel delete</button></p>}
    {operationError && <p role="alert">{operationError}</p>}
    {offline && <p role="alert">File service offline; draft retained.</p>}
    {!offline && !visible && <p role="status">Loading file…</p>}
    {error && <p role="alert">{error.error || "Unable to read file"}</p>}
    {recovery && <><p role="alert">This draft needs recovery: its original base is unknown. Copy the text and resolve it outside this workspace; saving is disabled.</p><textarea aria-label="Recovery draft" readOnly value={recovery.content} /></>}
    {currentDraft && /\.(?:md|markdown)$/i.test(path) && <>
      <button type="button" aria-pressed={showMarkdown} onClick={() => setShowMarkdown(!showMarkdown)}>{showMarkdown ? "Hide Markdown preview" : "Preview Markdown"}</button>
      {showMarkdown && <div aria-label="Markdown preview"><InertMarkdown content={currentDraft.content} /></div>}
    </>}
    {currentDraft && <FileEditor content={loaded?.content ?? currentDraft.baseContent} revision={loaded?.revision ?? currentDraft.baseRevision}
      draft={currentDraft} availability={visible || offline ? availability : "disconnected"}
      onDraftChange={(next) => { if (live.current && isCurrent()) onDraftChange(path, next); }} onSave={saveCurrent} />}
  </section>;
}

function Workspace({ bindingKey, list, read, save, drafts, onDraftChange, createFile, createDirectory, rename, copy, remove, onPathRenamed, onPathRemoved, offline = false, storageWarning, conflictWarning }: FileWorkspaceProps) {
  const [selection, setSelection] = useState<{ path: string; generation: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selectionGeneration = useRef(0);
  const listCurrent = useCallback(async (path: string): Promise<FileExplorerEntry[]> => {
    if (offline) throw new Error("File service offline");
    return list(path);
  }, [list, offline]);
  const create = async (operation: (path: string) => Promise<void>) => {
    if (!validEntryName(newName)) { setCreateError("Enter one name without slashes"); return; }
    setCreating(true); setCreateError(null);
    try { await operation(newName); setNewName(""); setRefresh((value) => value + 1); }
    catch (error) { setCreateError(error instanceof Error ? error.message : "Unable to create entry"); }
    finally { setCreating(false); }
  };
  return <div className="file-workspace">
    {storageWarning && <p role="alert">{storageWarning}</p>}
    {conflictWarning && <p role="alert">{conflictWarning}</p>}
    <p className="file-workspace-note">Upload, search, and conflict resolution are not supported in this workspace.</p>
    {(createFile || createDirectory) && <form onSubmit={(event) => { event.preventDefault(); if (createFile) void create(createFile); }}>
      <input aria-label="New name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={offline || creating} />
      {createFile && <button type="submit" disabled={offline || creating}>Create file</button>}
      {createDirectory && <button type="button" disabled={offline || creating} onClick={() => void create(createDirectory)}>Create directory</button>}
      {createError && <span role="alert">{createError}</span>}
    </form>}
    <div className="file-workspace-columns">
      <nav aria-label="Browse files"><h2>Files</h2><FileExplorer rootId={`${bindingKey}:${refresh}`} list={listCurrent} onOpen={(path) => {
        const generation = ++selectionGeneration.current;
        setSelection({ path, generation });
      }} /></nav>
      {selection ? <SelectedFile key={selection.generation} selection={selection} selectionGeneration={selectionGeneration} read={read} save={save} rename={rename} copy={copy}
        remove={remove}
        onPathRenamed={(from, to) => { onPathRenamed?.(from, to); selectionGeneration.current++; setSelection(null); setRefresh((value) => value + 1); }}
        onPathRemoved={(path) => { onPathRemoved?.(path); selectionGeneration.current++; setSelection(null); setRefresh((value) => value + 1); }}
        onPathCopied={() => setRefresh((value) => value + 1)}
        draft={drafts[selection.path]} onDraftChange={onDraftChange} offline={offline} /> : <p>Select a file to view or edit.</p>}
    </div>
  </div>;
}

function SelectedFile({ selection, selectionGeneration, ...props }: Omit<Parameters<typeof FilePanel>[0], "path" | "isCurrent"> & {
  selection: { path: string; generation: number }; selectionGeneration: { current: number };
}) {
  const isCurrent = useCallback(() => selectionGeneration.current === selection.generation, [selectionGeneration, selection.generation]);
  return <FilePanel {...props} path={selection.path} isCurrent={isCurrent} />;
}

/** Standalone workspace: the owner supplies binding-scoped operations and durable drafts. */
export function FileWorkspace(props: FileWorkspaceProps) {
  return <Workspace key={props.bindingKey} {...props} />;
}
