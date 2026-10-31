/**
 * Pi Bridge session-tree picker.
 *
 * The Pi TUI stays authoritative: `/herdr-tree` publishes the current session
 * tree to herdr-web and waits. The browser can only choose one of the entry ids
 * that were published for that picker, and only while that picker is the open
 * one, so a stale card can never navigate a session that has moved on.
 *
 * Summaries are deliberately unsupported: `ctx.navigateTree` has no equivalent
 * of the built-in tree's summary and queue handling, so this module publishes
 * plain entries and the command re-checks the session right before it navigates.
 */

export const TREE_PICKER_LIMIT = 200;
const PREVIEW_LIMIT = 80;

export interface SessionTreeEntryLike {
  type?: string;
  id?: string;
  message?: { role?: string; content?: unknown; toolName?: string };
  content?: unknown;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  label?: string;
}

export interface SessionTreeNodeLike {
  entry: SessionTreeEntryLike;
  children?: SessionTreeNodeLike[];
  label?: string;
}

export interface TreePickerNode {
  entry_id: string;
  label: string;
  depth: number;
  current: boolean;
}

export interface TreePickerView {
  id: string;
  session_id: string;
  leaf_id: string | null;
  title: string;
  nodes: TreePickerNode[];
  omitted: number;
}

export type TreePickerOutcome = "answered" | "cancelled";

export type TreePickerAnswer = { entryId: string } | null;

export interface TreePickerOpenInput {
  sessionId: string;
  leafId: string | null;
  tree: SessionTreeNodeLike[];
}

export type TreePickerPublish = (view: TreePickerView | null, outcome?: TreePickerOutcome) => void;

export interface TreePickerOptions {
  limit?: number;
  createId?: () => string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join(" ");
}

function normalize(text: string): string {
  return text.replace(/[\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function labelFor(entry: SessionTreeEntryLike): string {
  if (entry.type === "message") {
    const role = entry.message?.role ?? "message";
    if (role === "toolResult") {
      return `[tool] ${entry.message?.toolName ?? "tool"}`;
    }
    if (role !== "user" && role !== "assistant") {
      return `[${role}]`;
    }
    const preview = normalize(textOf(entry.message?.content)).slice(0, PREVIEW_LIMIT);
    return `${role}: ${preview || "(empty)"}`;
  }
  if (entry.type === "model_change") {
    return `Model: ${[entry.provider, entry.modelId].filter(Boolean).join("/") || "(unknown)"}`;
  }
  if (entry.type === "thinking_level_change") {
    return `Thinking: ${normalize(entry.thinkingLevel ?? "") || "(unknown)"}`;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    const preview = normalize(entry.summary ?? "").slice(0, PREVIEW_LIMIT);
    return `${entry.type === "branch_summary" ? "Branch" : "Compaction"} summary: ${preview || "(empty)"}`;
  }
  if (entry.type === "label") {
    return `Label: ${normalize(entry.label ?? "").slice(0, PREVIEW_LIMIT) || "(empty)"}`;
  }
  const preview = normalize(textOf(entry.content)).slice(0, PREVIEW_LIMIT);
  const kind = entry.type ?? "entry";
  return preview ? `[${kind}] ${preview}` : `[${kind}]`;
}

function entryIdOf(node: SessionTreeNodeLike): string | null {
  const id = node.entry?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Flattens the Pi session tree into publishable rows in depth-first order.
 * Entries past `limit` are dropped and counted, because a phone should never be
 * asked to render an unbounded tree.
 */
export function treePickerNodes(
  tree: SessionTreeNodeLike[],
  options: { leafId?: string | null; limit?: number } = {},
): { nodes: TreePickerNode[]; omitted: number } {
  const limit = Math.max(1, options.limit ?? TREE_PICKER_LIMIT);
  const leafId = options.leafId ?? null;
  const nodes: TreePickerNode[] = [];
  let total = 0;
  const walk = (list: SessionTreeNodeLike[], depth: number) => {
    for (const node of list) {
      const entryId = entryIdOf(node);
      if (entryId !== null) {
        total += 1;
        if (nodes.length < limit) {
          nodes.push({
            entry_id: entryId,
            label: labelFor(node.entry),
            depth,
            current: entryId === leafId,
          });
        }
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        walk(node.children, entryId === null ? depth : depth + 1);
      }
    }
  };
  walk(tree, 0);
  for (let round = 0; round < nodes.length; round += 1) {
    const groups = new Map<string, TreePickerNode[]>();
    for (const node of nodes) {
      const group = groups.get(node.label) ?? [];
      group.push(node);
      groups.set(node.label, group);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    if (collisions.length === 0) break;
    for (const group of collisions) {
      for (const node of group) {
        let length = Math.min(4, node.entry_id.length);
        while (length < node.entry_id.length && group.some((other) =>
          other !== node && other.entry_id.startsWith(node.entry_id.slice(0, length)))) {
          length += 1;
        }
        node.label += ` [${node.entry_id.slice(0, length)}]`;
      }
    }
  }
  return { nodes, omitted: Math.max(0, total - nodes.length) };
}

export function createTreePicker(publish: TreePickerPublish, options: TreePickerOptions = {}) {
  const limit = options.limit ?? TREE_PICKER_LIMIT;
  const createId = options.createId ?? (() => `tree-${Math.random().toString(36).slice(2, 10)}`);
  let pending: {
    view: TreePickerView;
    settled: boolean;
    resolve: (answer: TreePickerAnswer) => void;
  } | null = null;

  function settle(answer: TreePickerAnswer, outcome: TreePickerOutcome): void {
    const current = pending;
    if (!current || current.settled) return;
    current.settled = true;
    pending = null;
    publish(null, outcome);
    current.resolve(answer);
  }

  const api = {
    isOpen(): boolean {
      return pending !== null;
    },
    /** Publishes a new picker, or returns null while one is already waiting. */
    open(input: TreePickerOpenInput): TreePickerView | null {
      if (pending) return null;
      const { nodes, omitted } = treePickerNodes(input.tree, { leafId: input.leafId, limit });
      if (nodes.length === 0) return null;
      const view: TreePickerView = {
        id: createId(),
        session_id: input.sessionId,
        leaf_id: input.leafId,
        title: "Pi session tree",
        nodes,
        omitted,
      };
      pending = { view, settled: false, resolve: () => {} };
      publish(view);
      return view;
    },
    /** Resolves with the chosen entry, or null when the picker is cancelled. */
    wait(pickerId: string): Promise<TreePickerAnswer> {
      const current = pending;
      if (!current || current.view.id !== pickerId) return Promise.resolve(null);
      return new Promise<TreePickerAnswer>((resolve) => {
        current.resolve = resolve;
      });
    },
    /** Accepts one published entry id; anything else leaves the picker waiting. */
    answer(input: { pickerId: string; entryId: string }): boolean {
      const current = pending;
      if (!current || current.settled || current.view.id !== input.pickerId) return false;
      if (!current.view.nodes.some((node) => node.entry_id === input.entryId)) return false;
      settle({ entryId: input.entryId }, "answered");
      return true;
    },
    cancel(pickerId: string): boolean {
      const current = pending;
      if (!current || current.settled || current.view.id !== pickerId) return false;
      settle(null, "cancelled");
      return true;
    },
    snapshot(): TreePickerView[] {
      return pending ? [pending.view] : [];
    },
    cancelAll(): void {
      api.stop();
    },
    stop(): void {
      const current = pending;
      if (!current) return;
      settle(null, "cancelled");
    },
  };
  return api;
}

export type TreePicker = ReturnType<typeof createTreePicker>;
