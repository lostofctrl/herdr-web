import assert from "node:assert/strict";
import test from "node:test";

import { createTreePicker, treePickerNodes, TREE_PICKER_LIMIT } from "../src/tree-picker.ts";

function recordPublishes() {
  const published = [];
  return { published, publish: (view, outcome) => published.push({ view, outcome }) };
}

function node(entryId, role, text, children = [], extra = {}) {
  return {
    entry: {
      type: "message",
      id: entryId,
      message: { role, content: text, ...extra },
    },
    children,
  };
}

test("builds depth-first previews for message and non-message entries", () => {
  const tree = [
    node("a", "user", "first question", [
      node("b", "assistant", "first answer", [node("c", "toolResult", "", [], { toolName: "read" })]),
    ]),
    { entry: { type: "label", id: "d" }, children: [] },
  ];
  const { nodes, omitted } = treePickerNodes(tree, { leafId: "b" });
  assert.equal(omitted, 0);
  assert.deepEqual(
    nodes.map((entry) => [entry.entry_id, entry.depth, entry.current, entry.label]),
    [
      ["a", 0, false, "user: first question"],
      ["b", 1, true, "assistant: first answer"],
      ["c", 2, false, "[tool] read"],
      ["d", 0, false, "Label: (empty)"],
    ],
  );
});

test("bounds every label and keeps a pathological model record publishable", () => {
  const huge = "x".repeat(1_100_000);
  const picker = createTreePicker(() => {}, { createId: () => "picker" });
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    { entry: { type: "model_change", id: "model", provider: huge, modelId: huge } },
    { entry: { type: "thinking_level_change", id: "think", thinkingLevel: huge } },
    { entry: { type: "message", id: "tool", message: { role: "toolResult", toolName: huge } } },
    { entry: { type: huge, id: "custom", content: huge } },
    { entry: { type: "branch_summary", id: "summary", summary: huge } },
    { entry: { type: "label", id: "label", label: huge } },
  ] });
  for (const row of view.nodes) assert.ok(row.label.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "tree_picker_open", picker: view }) + "\n") <= 1024 * 1024);
});

test("keeps a full tree of pathological labels publishable under the record cap", () => {
  // Worst case: every published row at the cap, the longest useful entry id and
  // labels that JSON has to escape, across TREE_PICKER_LIMIT rows.
  const huge = (
    "x\\\"\n\t\\".repeat(5000)
  );
  const tree = Array.from({ length: TREE_PICKER_LIMIT }, (_, index) => ({
    entry: {
      type: "model_change",
      id: `entry-${String(index).padStart(6, "0")}-${huge.slice(0, 32)}`,
      provider: huge,
      modelId: huge,
    },
  }));
  const picker = createTreePicker(() => {}, { createId: () => "picker" });
  const view = picker.open({ sessionId: "s1", leafId: null, tree });
  assert.equal(view.nodes.length, TREE_PICKER_LIMIT);
  const encoded = Buffer.byteLength(JSON.stringify({ type: "tree_picker_open", picker: view }) + "\n");
  assert.ok(encoded <= 1024 * 1024, `published record was ${encoded} bytes`);
  assert.ok(encoded < 1024 * 1024 / 4, `published record should stay well inside the cap, was ${encoded} bytes`);
});

test("publishes readable model changes", () => {
  const picker = createTreePicker(() => {}, { createId: () => "picker" });
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    { entry: { type: "model_change", id: "model-1", provider: "anthropic", modelId: "claude-sonnet" } },
  ] });
  assert.equal(view.nodes[0].label, "Model: anthropic/claude-sonnet");
});

test("publishes readable thinking, summary and label entries", () => {
  const picker = createTreePicker(() => {});
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    { entry: { type: "thinking_level_change", id: "think", thinkingLevel: "high" } },
    { entry: { type: "branch_summary", id: "branch", summary: "Branch\nsummary" } },
    { entry: { type: "compaction", id: "compact", summary: "Compact summary" } },
    { entry: { type: "label", id: "label", label: "Checkpoint" } },
    { entry: { type: "mystery", id: "unknown" } },
  ] });
  assert.deepEqual(view.nodes.map((entry) => entry.label), [
    "Thinking: high", "Branch summary: Branch summary", "Compaction summary: Compact summary", "Label: Checkpoint", "[mystery]",
  ]);
});

test("keeps custom entry previews and supplies readable empty fallbacks", () => {
  const picker = createTreePicker(() => {});
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    { entry: { type: "custom", id: "custom", content: "  custom\nentry  " } },
    { entry: { type: "model_change", id: "model" } },
    { entry: { type: "thinking_level_change", id: "thinking" } },
    { entry: { type: "branch_summary", id: "summary" } },
    { entry: { type: "label", id: "label" } },
  ] });
  assert.deepEqual(view.nodes.map((entry) => entry.label), [
    "[custom] custom entry", "Model: (unknown)", "Thinking: (unknown)", "Branch summary: (empty)", "Label: (empty)",
  ]);
});

test("disambiguates only colliding published labels without changing entry ids", () => {
  const picker = createTreePicker(() => {}, { limit: 5 });
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    node("abcd1000", "user", "repeat"),
    node("abcd2000", "user", "repeat"),
    node("efgh3000", "user", "unique"),
    node("ijkl4000", "user", "unique"),
    node("mnop5000", "user", "outside limit"),
    node("qrst6000", "user", "outside limit"),
  ] });
  assert.deepEqual(view.nodes.map(({ entry_id, label }) => [entry_id, label]), [
    ["abcd1000", "user: repeat [abcd1]"],
    ["abcd2000", "user: repeat [abcd2]"],
    ["efgh3000", "user: unique [efgh]"],
    ["ijkl4000", "user: unique [ijkl]"],
    ["mnop5000", "user: outside limit"],
  ]);
});

test("keeps labels distinct when a suffix matches another original label", () => {
  const picker = createTreePicker(() => {});
  const view = picker.open({ sessionId: "s1", leafId: null, tree: [
    node("aaaa1111", "user", "repeat"),
    node("bbbb2222", "user", "repeat"),
    node("cccc3333", "user", "repeat [aaaa]"),
  ] });
  assert.deepEqual(view.nodes.map((entry) => entry.label), [
    "user: repeat [aaaa] [aaaa]", "user: repeat [bbbb]", "user: repeat [aaaa] [cccc]",
  ]);
});

test("collapses whitespace and shortens long previews", () => {
  const long = "line one\n\nline two ".repeat(20);
  const tree = [node("a", "user", long)];
  const [entry] = treePickerNodes(tree).nodes;
  assert.equal(entry.label.includes("\n"), false);
  assert.equal(entry.label.startsWith("user: line one line two"), true);
  assert.equal(entry.label.length <= 100, true);
});

test("caps the published tree and reports how many entries were dropped", () => {
  const tree = Array.from({ length: TREE_PICKER_LIMIT + 5 }, (_, index) => node(`n${index}`, "user", `m${index}`));
  const { nodes, omitted } = treePickerNodes(tree);
  assert.equal(nodes.length, TREE_PICKER_LIMIT);
  assert.equal(omitted, 5);
});

test("pins a nested leaf at its original depth when only one row fits", () => {
  const picker = createTreePicker(() => {}, { limit: 1 });
  const view = picker.open({ sessionId: "s1", leafId: "leaf", tree: [
    node("root", "user", "root", [node("leaf", "assistant", "here")]),
  ] });
  assert.deepEqual(view.nodes, [{ entry_id: "leaf", label: "assistant: here", depth: 1, current: true }]);
  assert.equal(view.omitted, 1);
});

test("publishes an open view and resolves only the matching answer", async () => {
  const { published, publish } = recordPublishes();
  const picker = createTreePicker(publish, { createId: () => "picker-1" });
  const view = picker.open({ sessionId: "s1", leafId: "a", tree: [node("a", "user", "hi")] });
  assert.equal(view?.id, "picker-1");
  assert.equal(published.length, 1);
  assert.equal(published[0].view.id, "picker-1");
  assert.equal(picker.isOpen(), true);

  const answer = picker.wait("picker-1");
  assert.equal(picker.answer({ pickerId: "picker-1", entryId: "missing" }), false);
  assert.equal(picker.answer({ pickerId: "other", entryId: "a" }), false);
  assert.equal(picker.isOpen(), true);
  assert.equal(picker.answer({ pickerId: "picker-1", entryId: "a" }), true);
  assert.deepEqual(await answer, { entryId: "a" });
  assert.equal(picker.isOpen(), false);
  assert.deepEqual(published.at(-1), { view: null, outcome: "answered" });
});

test("ignores a second answer and a late cancel for the same picker", async () => {
  const { publish } = recordPublishes();
  const picker = createTreePicker(publish, { createId: () => "picker-2" });
  picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi"), node("b", "user", "there")] });
  const answer = picker.wait("picker-2");
  assert.equal(picker.answer({ pickerId: "picker-2", entryId: "a" }), true);
  assert.equal(picker.answer({ pickerId: "picker-2", entryId: "b" }), false);
  assert.equal(picker.cancel("picker-2"), false);
  assert.deepEqual(await answer, { entryId: "a" });
});

test("resolves a cancelled picker with null and closes it", async () => {
  const { published, publish } = recordPublishes();
  const picker = createTreePicker(publish, { createId: () => "picker-3" });
  picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi")] });
  const answer = picker.wait("picker-3");
  assert.equal(picker.cancel("picker-3"), true);
  assert.equal(await answer, null);
  assert.deepEqual(published.at(-1), { view: null, outcome: "cancelled" });
  assert.equal(picker.isOpen(), false);
});

test("refuses a second picker until the first is answered or cancelled", () => {
  const { publish } = recordPublishes();
  const picker = createTreePicker(publish, { createId: () => "picker-4" });
  assert.ok(picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi")] }));
  assert.equal(picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi")] }), null);
  picker.cancel("picker-4");
  assert.ok(picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi")] }));
});

test("stop cancels every pending picker once", async () => {
  const { published, publish } = recordPublishes();
  const picker = createTreePicker(publish, { createId: () => "picker-5" });
  picker.open({ sessionId: "s1", leafId: null, tree: [node("a", "user", "hi")] });
  const answer = picker.wait("picker-5");
  picker.stop();
  assert.equal(await answer, null);
  assert.deepEqual(published.at(-1), { view: null, outcome: "cancelled" });
  picker.stop();
  assert.equal(published.filter((entry) => entry.view === null).length, 1);
});
