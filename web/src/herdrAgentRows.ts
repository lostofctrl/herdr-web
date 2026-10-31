import type { AgentStatus, PaneInfo, WorkspaceInfo } from "./types";

export type HerdrAgentRowStyle = { fg?: string; bold?: boolean; dim?: boolean };
type TextKind = "state_text" | "machine" | "workspace" | "tab" | "pane" | "agent" | "terminal_title" | "terminal_title_stripped";
export type HerdrAgentRowToken =
  | { kind: "state_icon"; status: AgentStatus; style: HerdrAgentRowStyle; separatorBefore: string }
  | { kind: TextKind; value: string; style: HerdrAgentRowStyle; separatorBefore: string }
  | { kind: "custom"; name: string; value: string; style: HerdrAgentRowStyle; separatorBefore: string };

const textKinds: readonly string[] = ["state_text", "machine", "workspace", "tab", "pane", "agent", "terminal_title", "terminal_title_stripped"];
const conditions = ["equals", "contains", "starts_with", "gt", "lt"] as const;
type Condition = typeof conditions[number];
type Rule = { condition: Condition; expected: string | number; ignoreCase: boolean; hide: boolean; style: HerdrAgentRowStyle };
type ConfiguredToken = { name: string; style: HerdrAgentRowStyle; rules: Rule[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function styleFrom(value: Record<string, unknown>): HerdrAgentRowStyle | null {
  const style: HerdrAgentRowStyle = {};
  if (value.fg != null) {
    if (typeof value.fg !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.fg)) return null;
    const hex = value.fg.slice(1).toLowerCase();
    style.fg = `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
  }
  for (const key of ["bold", "dim"] as const) {
    if (value[key] != null) {
      if (typeof value[key] !== "boolean") return null;
      style[key] = value[key];
    }
  }
  return style;
}

function parseRule(value: unknown): Rule | null {
  if (!record(value) || !allowedKeys(value, [...conditions, "ignore_case", "fg", "bold", "dim", "hide"])) return null;
  const present = conditions.filter((key) => value[key] != null);
  if (present.length !== 1) return null;
  const condition = present[0];
  const expected = value[condition];
  const numeric = condition === "gt" || condition === "lt";
  if (numeric ? typeof expected !== "number" || !Number.isFinite(expected) : typeof expected !== "string") return null;
  if (numeric && value.ignore_case != null) return null;
  if (value.ignore_case != null && typeof value.ignore_case !== "boolean") return null;
  if (value.hide != null && typeof value.hide !== "boolean") return null;
  const style = styleFrom(value);
  if (!style) return null;
  return { condition, expected: expected as string | number, ignoreCase: value.ignore_case === true, hide: value.hide === true, style };
}

function parseToken(value: unknown): ConfiguredToken | null {
  let name: unknown = value;
  let style: HerdrAgentRowStyle = {};
  const rules: Rule[] = [];
  if (record(value)) {
    if (!allowedKeys(value, ["token", "fg", "bold", "dim", "rules"])) return null;
    name = value.token;
    const parsedStyle = styleFrom(value);
    if (!parsedStyle || (value.rules !== undefined && !Array.isArray(value.rules))) return null;
    style = parsedStyle;
    if (Array.isArray(value.rules)) {
      if (value.rules.length > 16) return null;
      for (const item of value.rules) {
        const rule = parseRule(item);
        if (!rule) return null;
        rules.push(rule);
      }
    }
  }
  if (typeof name !== "string" || (name !== "state_icon" && !textKinds.includes(name) && !/^\$[a-zA-Z0-9_-]{1,32}$/.test(name))) return null;
  if (name === "state_icon" && rules.length) return null;
  return { name, style, rules };
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function matches(rule: Rule, value: string): boolean {
  if (rule.condition === "gt" || rule.condition === "lt") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return false;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    return rule.condition === "gt" ? number > (rule.expected as number) : number < (rule.expected as number);
  }
  const actual = rule.ignoreCase ? asciiLower(value) : value;
  const expected = rule.ignoreCase ? asciiLower(rule.expected as string) : rule.expected as string;
  if (rule.condition === "equals") return actual === expected;
  if (rule.condition === "contains") return actual.includes(expected);
  return actual.startsWith(expected);
}

/** Resolve one already-selected rows_by_agent layout. Null requests the caller's web fallback. */
export function resolveHerdrAgentRows(
  override: unknown,
  pane: PaneInfo,
  workspace: WorkspaceInfo,
  tabLabel?: string,
  machineLabel?: string,
): HerdrAgentRowToken[][] | null {
  if (!Array.isArray(override) || override.length > 16) return null;
  const parsed: ConfiguredToken[][] = [];
  for (const row of override) {
    if (!Array.isArray(row) || row.length > 16) return null;
    const tokens: ConfiguredToken[] = [];
    for (const item of row) {
      const token = parseToken(item);
      if (!token) return null;
      tokens.push(token);
    }
    parsed.push(tokens);
  }

  const values: Record<TextKind, string | undefined> = {
    state_text: pane.state_labels?.[pane.agent_status] ?? (pane.agent_status === "unknown" ? "idle" : pane.agent_status),
    machine: machineLabel,
    workspace: workspace.label,
    tab: tabLabel,
    pane: pane.title ?? pane.label,
    agent: pane.display_agent ?? pane.agent ?? pane.title,
    terminal_title: pane.terminal_title,
    terminal_title_stripped: pane.terminal_title_stripped,
  };
  const rows: HerdrAgentRowToken[][] = [];
  for (const row of parsed) {
    const resolved: HerdrAgentRowToken[] = [];
    for (const token of row) {
      const custom = token.name.startsWith("$");
      const customName = token.name.slice(1);
      const value = custom
        ? (pane.tokens && Object.hasOwn(pane.tokens, customName) ? pane.tokens[customName] : undefined)
        : values[token.name as TextKind];
      if (token.name !== "state_icon" && value == null) continue;
      const rule = value === undefined ? undefined : token.rules.find((item) => matches(item, value));
      if (rule?.hide) continue;
      const style = { ...token.style, ...rule?.style };
      const separatorBefore = resolved.length === 0 ? "" : resolved[resolved.length - 1].kind === "state_icon" ? " " : " · ";
      if (token.name === "state_icon") {
        resolved.push({ kind: "state_icon", status: pane.agent_status, style, separatorBefore });
      } else if (custom) {
        resolved.push({ kind: "custom", name: customName, value: value!, style, separatorBefore });
      } else {
        resolved.push({ kind: token.name as TextKind, value: value!, style, separatorBefore });
      }
    }
    if (resolved.length) rows.push(resolved);
  }
  return rows;
}
