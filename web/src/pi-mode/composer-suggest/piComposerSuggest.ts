import type { PiCatalog, PiCatalogEntry } from "../../pi/piProtocol";

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
  /** Text that replaces the trigger token when picked. */
  insert: string;
};

function whitespaceBetween(text: string) {
  return /\s/.test(text);
}

/**
 * Finds the suggestion token around `cursor`. `/` only counts as the first
 * character of the draft; `@` counts inside the word the cursor is in.
 */
export function piComposerTrigger(
  draft: string,
  cursor: number,
): PiComposerTrigger | null {
  const position = Math.max(0, Math.min(cursor, draft.length));

  if (draft.startsWith("/") && position > 0) {
    const token = draft.slice(0, position);
    if (!whitespaceBetween(token)) {
      return { kind: "slash", start: 0, query: token.slice(1) };
    }
  }

  const at = draft.lastIndexOf("@", position - 1);
  if (at < 0) {
    return null;
  }
  if (at > 0 && !/\s/.test(draft[at - 1])) {
    return null;
  }
  const token = draft.slice(at + 1, position);
  if (whitespaceBetween(token)) {
    return null;
  }
  return { kind: "file", start: at, query: token };
}

export function piComposerTriggerKey(trigger: PiComposerTrigger | null) {
  return trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;
}

/** Normalises what a picked row writes back into the draft. */
export function piComposerSuggestionInsertion(
  kind: PiComposerSuggestionKind,
  name: string,
) {
  if (kind === "command") {
    return name.startsWith("/") ? name : `/${name}`;
  }
  if (kind === "file") {
    return name.startsWith("@") ? name : `@${name}`;
  }
  return name;
}

/**
 * Replaces only the trigger token up to the cursor. Text after the cursor is
 * kept byte-for-byte, so picking never disturbs the rest of the draft.
 */
export function applyPiComposerSuggestion(
  draft: string,
  trigger: PiComposerTrigger,
  cursor: number,
  insertion: string,
) {
  const position = Math.max(trigger.start, Math.min(cursor, draft.length));
  return {
    value: draft.slice(0, trigger.start) + insertion + draft.slice(position),
    cursor: trigger.start + insertion.length,
  };
}

function catalogEntry(
  kind: "command" | "skill",
  entry: PiCatalogEntry,
): PiComposerSuggestion {
  const insert = piComposerSuggestionInsertion(kind, entry.name);
  return {
    id: `${kind}:${entry.name}`,
    kind,
    label: insert,
    description: entry.description,
    insert,
  };
}

/** Commands and skills share one filtered list; commands come first. */
export function piComposerCatalogSuggestions(
  catalog: PiCatalog | null,
  query: string,
): PiComposerSuggestion[] {
  if (!catalog) {
    return [];
  }
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  const entries = [
    ...(catalog.commands ?? []).map((entry) => catalogEntry("command", entry)),
    ...(catalog.skills ?? []).map((entry) => catalogEntry("skill", entry)),
  ];
  return entries
    .filter((entry) => {
      if (!needle) {
        return true;
      }
      return entry.label.toLowerCase().replace(/^\//, "").includes(needle);
    })
    .slice(0, PI_COMPOSER_SUGGESTION_LIMIT);
}

export function piComposerFileSuggestions(
  files: { path: string }[],
  query: string,
): PiComposerSuggestion[] {
  const needle = query.trim().toLowerCase();
  return files
    .filter((file) => !needle || file.path.toLowerCase().includes(needle))
    .slice(0, PI_COMPOSER_SUGGESTION_LIMIT)
    .map((file) => ({
      id: `file:${file.path}`,
      kind: "file" as const,
      label: file.path,
      description: "File",
      insert: piComposerSuggestionInsertion("file", file.path),
    }));
}
