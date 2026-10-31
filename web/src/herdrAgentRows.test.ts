import { describe, expect, it } from "vitest";
import { resolveHerdrAgentRows } from "./herdrAgentRows";
import type { PaneInfo, WorkspaceInfo } from "./types";

const pane: PaneInfo = {
  pane_id: "p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false,
  agent_status: "working", agent: "pi", display_agent: "Pi", title: "Session", label: "Pane",
  terminal_title: "⠋ title", terminal_title_stripped: "title",
  state_labels: { working: "Reviewing" }, tokens: { load: "90", empty: "" }, revision: 1,
};
const workspace: WorkspaceInfo = {
  workspace_id: "w", number: 1, label: "Repo", focused: false, pane_count: 1,
  tab_count: 1, active_tab_id: "tab", agent_status: "working",
};
const resolve = (layout: unknown, current = pane, machine?: string) =>
  resolveHerdrAgentRows(layout, current, workspace, "Tab", machine);

describe("Herdr agent row overrides", () => {
  it("returns null for missing or invalid layouts and preserves an intentionally empty override", () => {
    for (const value of [undefined, null, {}, "agent", ["agent"], [["unknown"]], [["$"]], [["$a.b"]]]) {
      expect(resolve(value)).toBeNull();
    }
    expect(resolve([])).toEqual([]);
    expect(resolve([[], ["$missing"]])).toEqual([]);
  });

  it("resolves every agent token with separators only between visible values", () => {
    expect(resolve([["state_icon", "$missing", "machine", "workspace", "tab", "pane", "agent", "state_text", "terminal_title", "terminal_title_stripped", "$load"]], pane, "Host")).toEqual([[
      { kind: "state_icon", status: "working", style: {}, separatorBefore: "" },
      { kind: "machine", value: "Host", style: {}, separatorBefore: " " },
      { kind: "workspace", value: "Repo", style: {}, separatorBefore: " · " },
      { kind: "tab", value: "Tab", style: {}, separatorBefore: " · " },
      { kind: "pane", value: "Session", style: {}, separatorBefore: " · " },
      { kind: "agent", value: "Pi", style: {}, separatorBefore: " · " },
      { kind: "state_text", value: "Reviewing", style: {}, separatorBefore: " · " },
      { kind: "terminal_title", value: "⠋ title", style: {}, separatorBefore: " · " },
      { kind: "terminal_title_stripped", value: "title", style: {}, separatorBefore: " · " },
      { kind: "custom", name: "load", value: "90", style: {}, separatorBefore: " · " },
    ]]);
    expect(resolve([["machine", "$missing", "agent"], ["$empty"]], { ...pane, title: undefined, display_agent: undefined }, undefined)).toEqual([
      [{ kind: "agent", value: "pi", style: {}, separatorBefore: "" }],
      [{ kind: "custom", name: "empty", value: "", style: {}, separatorBefore: "" }],
    ]);
    expect(resolve([["pane", "state_text"]], { ...pane, title: undefined, state_labels: {}, agent_status: "unknown" })).toEqual([[
      { kind: "pane", value: "Pane", style: {}, separatorBefore: "" },
      { kind: "state_text", value: "idle", style: {}, separatorBefore: " · " },
    ]]);
  });

  it("merges the first matching rule, supports hide and preserves explicit false", () => {
    const layout = [["state_icon", { token: "machine", fg: "#ABC", bold: true, dim: true, rules: [
      { equals: "LOCAL", ignore_case: true, fg: "#f00", bold: false },
      { contains: "ocal", hide: true },
    ] }, "agent"]];
    expect(resolve(layout, pane, "Local")).toEqual([[
      { kind: "state_icon", status: "working", style: {}, separatorBefore: "" },
      { kind: "machine", value: "Local", style: { fg: "#ff0000", bold: false, dim: true }, separatorBefore: " " },
      { kind: "agent", value: "Pi", style: {}, separatorBefore: " · " },
    ]]);
    expect(resolve(layout, pane, "MyLocal")?.[0].map((token) => token.kind)).toEqual(["state_icon", "agent"]);
    expect(resolve([[{ token: "agent", rules: [{ equals: "Pi", hide: false }, { contains: "", hide: true }] }]])?.[0]).toHaveLength(1);
    expect(resolve([[{ token: "agent", rules: [{ equals: "Pi", hide: true }] }]])).toEqual([]);
  });

  it("matches ASCII only and evaluates strict finite decimal and exponent values", () => {
    const rule = (condition: object, value: string) => resolve([[{ token: "$load", rules: [{ ...condition, bold: true }] }]], { ...pane, tokens: { load: value } })?.[0][0].style.bold;
    for (const condition of [{ equals: "ÉA" }, { contains: "ÉA" }, { starts_with: "ÉA" }]) {
      expect(rule({ ...condition, ignore_case: true }, "Éa")).toBe(true);
      expect(rule({ ...condition, ignore_case: true }, "éa")).toBeUndefined();
    }
    expect(rule({ contains: "" }, "anything")).toBe(true);
    expect(rule({ starts_with: "" }, "anything")).toBe(true);
    expect(rule({ equals: "" }, "")).toBe(true);
    for (const value of ["90", "+90", "8.1e1", ".9e2"]) expect(rule({ gt: 80 }, value)).toBe(true);
    for (const value of ["80", "90%", " 90", "90 ", "", "NaN", "inf", "1e999", "0x60", "90\n"]) expect(rule({ gt: 80 }, value)).toBeUndefined();
    expect(rule({ lt: 80 }, "-90")).toBe(true);
    expect(rule({ lt: 80 }, "80")).toBeUndefined();
  });

  it("validates all tokens, styles, rules and 16-item limits before resolving", () => {
    const invalid = [
      [[{ token: "agent", fg: "red" }]], [[{ token: "agent", fg: "#abcd" }]], [[{ token: "agent", fg: "#abc\n" }]], [["$name\n"]],
      [[{ token: "agent", bold: "true" }]], [[{ token: "agent", extra: true }]],
      [[{ token: "state_icon", rules: [{ equals: "x" }] }]],
      [[{ token: "agent", rules: [{ bold: true }] }]],
      [[{ token: "agent", rules: [{ equals: "x", contains: "x" }] }]],
      [[{ token: "agent", rules: [{ gt: "80" }] }]],
      [[{ token: "agent", rules: [{ gt: Infinity }] }]],
      [[{ token: "agent", rules: [{ gt: 80, ignore_case: false }] }]],
      [[{ token: "agent", rules: [{ equals: "x", hide: 1 }] }]],
      [[{ token: "agent", rules: [{ equals: "x", regex: "x" }] }]],
      [[{ token: "$missing", rules: [{ equals: 1 }] }]],
      Array.from({ length: 17 }, () => ["agent"]),
      [Array.from({ length: 17 }, () => "agent")],
      [[{ token: "agent", rules: Array.from({ length: 17 }, () => ({ equals: "x" })) }]],
      [[`$${"a".repeat(33)}`]],
    ];
    for (const layout of invalid) expect(resolve(layout), JSON.stringify(layout)).toBeNull();
    expect(resolve(Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => "agent")))).toHaveLength(16);
    expect(resolve([[{ token: "agent", fg: "#aBcDeF", rules: Array.from({ length: 16 }, () => ({ equals: "x" })) }]])?.[0][0].style.fg).toBe("#abcdef");
    expect(resolve([[`$${"a".repeat(32)}`]])).toEqual([]);
  });
});
