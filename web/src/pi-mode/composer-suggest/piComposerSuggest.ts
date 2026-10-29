import type { PiCatalog, PiCatalogEntry } from "../../pi/piProtocol";
import { piCatalogTrigger } from "../../pi/sidepanel/piSidePanelCatalog";

export const PI_COMPOSER_SUGGESTION_LIMIT = 20;
export const PI_COMPOSER_FILE_QUERY_LIMIT = 50;
export const PI_COMPOSER_FILE_DEBOUNCE_MS = 200;
export type PiComposerSuggestionKind = "command" | "skill" | "file";
export type PiComposerTrigger =
  | { kind: "slash"; start: 0; query: string }
  | { kind: "file"; start: number; query: string };
export type PiComposerSuggestion = {
  id: string;
  kind: PiComposerSuggestionKind;
  label: string;
  description: string;
  insert: string;
};

/** Slash is draft-initial; file references require a token boundary, not email. */
export function piComposerTrigger(draft: string, cursor: number): PiComposerTrigger | null {
  const position = Math.max(0, Math.min(cursor, draft.length));
  const before = draft.slice(0, position);
  if (/^\/[^\s]*$/.test(before)) return { kind: "slash", start: 0, query: before.slice(1) };
  // A quoted token may contain spaces, but a closing quote ends completion.
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s"]*))$/.exec(before);
  if (!match) return null;
  return { kind: "file", start: before.lastIndexOf("@", match.index + match[0].indexOf("@")), query: match[1] ?? match[2] };
}
export function piComposerTriggerKey(trigger: PiComposerTrigger | null) {
  return trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;
}
export function piComposerSuggestionInsertion(kind: PiComposerSuggestionKind, name: string) {
  if (kind !== "file") return piCatalogTrigger({ name, description: "", source: "" }, kind);
  const path = name.replace(/^@/, "");
  return `@${/[\s"]/.test(path) ? JSON.stringify(path) : path}`;
}

/** Preserve suffix text; consume only a closing quote and reuse its separator. */
export function applyPiComposerSuggestion(draft: string, trigger: PiComposerTrigger, cursor: number, insertion: string) {
  let position = Math.max(trigger.start, Math.min(cursor, draft.length));
  if (trigger.kind === "file" && draft[trigger.start + 1] === '"' && draft[position] === '"') position++;
  const suffix = draft.slice(position);
  const separator = /^\s/.test(suffix) ? "" : " ";
  return {
    value: draft.slice(0, trigger.start) + insertion + separator + suffix,
    cursor: trigger.start + insertion.length + (separator || (suffix.startsWith(" ") ? " " : "")).length,
  };
}
function catalogEntry(kind: "command" | "skill", entry: PiCatalogEntry): PiComposerSuggestion {
  const insert = piComposerSuggestionInsertion(kind, entry.name);
  return { id: `${kind}:${entry.name}`, kind, label: insert, description: entry.description, insert };
}
function nameRank(name: string, needle: string) {
  return name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
}
export function piComposerCatalogSuggestions(catalog: PiCatalog | null, query: string, skillsEnabled = true): PiComposerSuggestion[] {
  if (!catalog) return [];
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  return [
    ...catalog.commands.map(entry => catalogEntry("command", entry)),
    ...(skillsEnabled ? catalog.skills.map(entry => catalogEntry("skill", entry)) : []),
  ].filter(entry => `${entry.label} ${entry.description}`.toLowerCase().includes(needle))
    .sort((a, b) => nameRank(a.label.toLowerCase().replace(/^\/(?:skill:)?/, ""), needle) - nameRank(b.label.toLowerCase().replace(/^\/(?:skill:)?/, ""), needle))
    .slice(0, PI_COMPOSER_SUGGESTION_LIMIT);
}
export function piComposerFileSuggestions(files: { path: string }[], query: string): PiComposerSuggestion[] {
  const needle = query.toLowerCase();
  const rank = (path: string) => {
    const lower = path.toLowerCase();
    const base = lower.split("/").at(-1) ?? lower;
    return lower === needle ? 0 : base.startsWith(needle) ? 1 : lower.startsWith(needle) ? 2 : 3;
  };
  return files.filter(file => file.path.toLowerCase().includes(needle))
    .sort((a,b) => rank(a.path) - rank(b.path))
    .slice(0, PI_COMPOSER_SUGGESTION_LIMIT)
    .map(file => ({id: `file:${file.path}`, kind: "file", label: file.path, description: "Tracked file", insert: piComposerSuggestionInsertion("file", file.path)}));
}
