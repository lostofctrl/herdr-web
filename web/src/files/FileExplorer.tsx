import { useEffect, useState, type KeyboardEvent } from "react";
import "./FileExplorer.css";

export interface FileExplorerEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  /** A listing-time hint only; operations must resolve the path safely again. */
  resolved_kind?: "file" | "directory";
}

export interface FileExplorerProps {
  /** Change whenever the owning root or its capability binding changes. */
  rootId: string;
  /** Lists immediate children of a root-relative directory; "." denotes the root.
   * Keep this callback stable unless listings should be reloaded.
   */
  list: (path: string) => Promise<FileExplorerEntry[]>;
  onOpen: (path: string) => void;
}

type List = FileExplorerProps["list"];
type Result = { list: List; attempt: number; entries: FileExplorerEntry[]; error?: never } | { list: List; attempt: number; error: string; entries?: never };
type TreeContext = { list: List; onOpen: FileExplorerProps["onOpen"]; active: string | null; setActive: (path: string | null) => void };

function Directory({ path, context, root = false }: { path: string; context: TreeContext; root?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const { list, setActive } = context;
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => current ? list(path) : null).then(
      (entries) => { if (current && entries) { if (root) setActive(null); setResult({ list, attempt, entries }); } },
      (error: unknown) => { if (current) setResult({ list, attempt, error: error instanceof Error ? error.message : "Unable to list directory" }); },
    );
    return () => { current = false; };
  }, [list, path, attempt, root, setActive]);

  const visible = result?.list === list && result.attempt === attempt ? result : null;
  const children = visible?.entries?.filter((entry) => entry.name && entry.name !== "." && entry.name !== ".." && !entry.name.includes("/") &&
    (entry.kind === "file" || entry.kind === "directory" || entry.kind === "symlink")).map((entry, index) => {
    const childPath = path === "." ? entry.name : `${path}/${entry.name}`;
    return <Entry key={childPath} entry={entry} path={childPath} context={context} first={root && index === 0} />;
  });
  return <ul role={root ? "tree" : "group"} aria-label={root ? "Files" : undefined} className={root ? "file-explorer-tree" : "file-explorer-group"}>
    {!visible && <li role="none" className="file-explorer-message"><span role="status">Loading…</span></li>}
    {visible?.error !== undefined && <li role="none" className="file-explorer-message"><span role="alert">{visible.error || "Unable to list directory"}</span> <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></li>}
    {visible?.entries && (children?.length ? children : <li role="none" className="file-explorer-message">Empty directory</li>)}
  </ul>;
}

function Entry({ entry, path, context, first }: { entry: FileExplorerEntry; path: string; context: TreeContext; first: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const link = entry.kind === "symlink";
  const directory = entry.kind === "directory" || (link && entry.resolved_kind === "directory");
  const unavailable = link && entry.resolved_kind !== "file" && entry.resolved_kind !== "directory";
  return <li role="none" className="file-explorer-entry">
    <button type="button" role="treeitem" className="file-explorer-item" aria-expanded={directory ? expanded : undefined} aria-disabled={unavailable || undefined}
      tabIndex={context.active === path || (context.active === null && first) ? 0 : -1}
      onFocus={() => context.setActive(path)} onClick={() => { context.setActive(path); if (unavailable) return; if (directory) setExpanded((value) => !value); else context.onOpen(path); }}>
      <span aria-hidden="true" className="file-explorer-icon">{directory ? (expanded ? "▾" : "▸") : "·"}</span><span className="file-explorer-name">{entry.name}</span>{link && <span className="file-explorer-link-label">{unavailable ? "(symbolic link, unavailable)" : "(symbolic link)"}</span>}
    </button>
    {directory && expanded && <Directory path={path} context={context} />}
  </li>;
}

function ExplorerRoot({ list, onOpen }: Omit<FileExplorerProps, "rootId">) {
  const [active, setActive] = useState<string | null>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "treeitem") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
    const index = items.indexOf(target);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case "ArrowDown": next = items[index + 1]; break;
      case "ArrowUp": next = items[index - 1]; break;
      case "Home": next = items[0]; break;
      case "End": next = items[items.length - 1]; break;
      case "ArrowRight":
        if (target.getAttribute("aria-expanded") === "false") target.click();
        else if (target.getAttribute("aria-expanded") === "true") next = target.parentElement?.querySelector<HTMLButtonElement>('[role="group"] [role="treeitem"]') ?? undefined;
        break;
      case "ArrowLeft":
        if (target.getAttribute("aria-expanded") === "true") target.click();
        else next = target.parentElement?.parentElement?.closest("li")?.querySelector<HTMLButtonElement>(':scope > [role="treeitem"]') ?? undefined;
        break;
      default: return;
    }
    event.preventDefault();
    next?.focus();
  }
  return <div className="file-explorer" onKeyDown={onKeyDown}><Directory path="." context={{ list, onOpen, active, setActive }} root /></div>;
}

/** Presentation-only explorer; callers own listing, opening and root identity. */
export function FileExplorer({ rootId, list, onOpen }: FileExplorerProps) {
  return <ExplorerRoot key={rootId} list={list} onOpen={onOpen} />;
}
