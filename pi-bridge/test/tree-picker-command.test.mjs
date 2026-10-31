import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension, expectNoRecord } from "./helpers.mjs";

const PANE_ID = "workspace-1:tab-2:pane-3";

const TREE = [
  {
    entry: { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "plan the picker" }] } },
    children: [
      {
        entry: { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "implemented" }] } },
        children: [
          {
            entry: { type: "message", id: "e3", message: { role: "toolResult", toolName: "bash", content: [] } },
            children: [],
          },
        ],
      },
    ],
  },
];

async function startBridge(options = {}) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-tree-"));
  const fake = createFakeExtension(options);
  const bridge = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: PANE_ID, XDG_RUNTIME_DIR: runtimeDir },
    exec: fake.pi.exec,
  });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  const connection = await connect(path.join(runtimeDir, "pi-bridge", `${PANE_ID}.sock`));
  await connection.next((record) => record.type === "hello");
  return {
    fake,
    bridge,
    connection,
    runtimeDir,
    async stop() {
      await bridge.stop();
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}

/** A terminal command context with the session APIs `/herdr-tree` reads. */
function commandContext(fake, overrides = {}) {
  const navigations = [];
  const notices = [];
  const session = { id: "session-1", leafId: "e3" };
  const ctx = {
    ...fake.ctx,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    navigateTree: async (entryId, options) => {
      navigations.push({ entryId, options });
      return { cancelled: false };
    },
    sessionManager: {
      ...fake.ctx.sessionManager,
      getSessionId: () => session.id,
      getLeafId: () => session.leafId,
      getTree: () => TREE,
    },
    ui: {
      ...fake.ctx.ui,
      getEditorText: () => "",
      notify: (message, type) => notices.push({ message, type }),
      // The waiting component: stays open until the bridge dismisses it.
      custom: (factory) =>
        new Promise((resolve) => {
          let closed = false;
          const done = (value) => {
            closed = true;
            resolve(value);
          };
          factory(null, null, null, done);
          ctx.dismissWait = () => {
            if (!closed) done(undefined);
          };
        }),
    },
    ...overrides,
  };
  return { ctx, navigations, notices, session };
}

test("does not advertise the picker capability without pi.registerCommand", async () => {
  const started = await startBridge({ registerCommand: false });
  try {
    const state = await started.connection.next((record) => record.type === "state");
    assert.equal(state.busy, "idle");
    assert.equal(started.fake.commands.has("herdr-tree"), false);
  } finally {
    await started.stop();
  }
});

test("registers /herdr-tree and refuses it outside the terminal UI", async () => {
  const started = await startBridge();
  try {
    assert.ok(started.fake.commands.has("herdr-tree"));
    const { ctx, notices } = commandContext(started.fake, { mode: "rpc" });

    await started.fake.runCommand("herdr-tree", "", ctx);

    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /needs interactive Pi/);
    await expectNoRecord(started.connection, (record) => record.type === "tree_picker_open");
  } finally {
    await started.stop();
  }
});

test("refuses while Pi is busy, has queued messages, or holds a draft", async () => {
  const started = await startBridge();
  try {
    const busy = commandContext(started.fake, { isIdle: () => false });
    await started.fake.runCommand("herdr-tree", "", busy.ctx);
    assert.match(busy.notices[0].message, /finish its current run/);

    const queued = commandContext(started.fake, { hasPendingMessages: () => true });
    await started.fake.runCommand("herdr-tree", "", queued.ctx);
    assert.match(queued.notices[0].message, /queued messages/);

    const draft = commandContext(started.fake);
    draft.ctx.ui.getEditorText = () => "half-written prompt";
    await started.fake.runCommand("herdr-tree", "", draft.ctx);
    assert.match(draft.notices[0].message, /Clear the editor draft/);

    await expectNoRecord(started.connection, (record) => record.type === "tree_picker_open");
  } finally {
    await started.stop();
  }
});

test("sends the waiting picker on a fresh connection", async () => {
  const started = await startBridge();
  let second;
  try {
    const { ctx } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");
    second = await connect(path.join(started.runtimeDir, "pi-bridge", `${PANE_ID}.sock`));
    assert.deepEqual(await second.next((record) => record.type === "tree_picker_open"), open);
    await second.send({ type: "tree_picker_cancel", id: "cancel-fresh", picker_id: open.picker.id });
    assert.deepEqual((await second.next((record) => record.id === "cancel-fresh")).result, { accepted: true });
    await running;
  } finally {
    await second?.close();
    await started.stop();
  }
});

test("resends an open picker after a snapshot and omits it after closure", async () => {
  const started = await startBridge();
  try {
    const { ctx } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");

    await started.connection.send({ type: "get_snapshot", id: "snapshot-open" });
    const response = await started.connection.next((record) =>
      record.id === "snapshot-open" || (record.type === "tree_picker_open" && record !== open));
    assert.equal(response.id, "snapshot-open");
    assert.equal(response.ok, true);
    assert.equal("tree_picker" in response.result, false);
    const replay = await started.connection.next((record) => record.type === "tree_picker_open" && record !== open);
    assert.deepEqual(replay, open);

    await started.connection.send({ type: "tree_picker_cancel", id: "cancel", picker_id: open.picker.id });
    await started.connection.next((record) => record.id === "cancel");
    await running;
    await started.connection.next((record) => record.type === "tree_picker_closed");
    await started.connection.send({ type: "get_snapshot", id: "snapshot-closed" });
    await started.connection.next((record) => record.id === "snapshot-closed");
    await expectNoRecord(started.connection, (record) => record.type === "tree_picker_open" && record !== open && record !== replay);
  } finally {
    await started.stop();
  }
});

test("publishes the session tree and navigates to the entry chosen on the phone", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);

    const open = await started.connection.next((record) => record.type === "tree_picker_open");
    assert.equal(open.picker.session_id, "session-1");
    assert.equal(open.picker.leaf_id, "e3");
    assert.deepEqual(
      open.picker.nodes.map((node) => [node.entry_id, node.depth, node.current]),
      [
        ["e1", 0, false],
        ["e2", 1, false],
        ["e3", 2, true],
      ],
    );
    assert.equal(open.picker.nodes[2].label, "[tool] bash");

    const state = await started.connection.next(
      (record) => record.type === "state" && record.busy === "dialog",
    );
    assert.equal(state.busy, "dialog");

    await started.connection.send({
      type: "tree_picker_answer",
      id: "pick-1",
      picker_id: open.picker.id,
      entry_id: "e1",
    });
    const response = await started.connection.next((record) => record.id === "pick-1");
    assert.deepEqual(response.result, { accepted: true });

    await running;
    assert.deepEqual(navigations, [{ entryId: "e1", options: { summarize: false } }]);
    const closed = await started.connection.next((record) => record.type === "tree_picker_closed");
    assert.equal(closed.outcome, "answered");
  } finally {
    await started.stop();
  }
});

test("publishes readable duplicate labels and navigates using the unchanged id", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations } = commandContext(started.fake);
    ctx.sessionManager.getTree = () => [
      { entry: { type: "model_change", id: "model001", provider: "anthropic", modelId: "sonnet" } },
      { entry: { type: "thinking_level_change", id: "think001", thinkingLevel: "high" } },
      { entry: { type: "branch_summary", id: "summary1", summary: "Earlier work" } },
      { entry: { type: "label", id: "label001", label: "Checkpoint" } },
      { entry: { type: "message", id: "aaaa1111", message: { role: "user", content: "repeat" } } },
      { entry: { type: "message", id: "bbbb2222", message: { role: "user", content: "repeat" } } },
    ];
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");
    assert.deepEqual(open.picker.nodes.map(({ entry_id, label }) => [entry_id, label]), [
      ["model001", "Model: anthropic/sonnet"], ["think001", "Thinking: high"],
      ["summary1", "Branch summary: Earlier work"], ["label001", "Label: Checkpoint"],
      ["aaaa1111", "user: repeat [aaaa]"], ["bbbb2222", "user: repeat [bbbb]"],
    ]);
    await started.connection.send({ type: "tree_picker_answer", id: "pick-label", picker_id: open.picker.id, entry_id: "bbbb2222" });
    assert.deepEqual((await started.connection.next((record) => record.id === "pick-label")).result, { accepted: true });
    await running;
    assert.deepEqual(navigations, [{ entryId: "bbbb2222", options: { summarize: false } }]);
  } finally {
    await started.stop();
  }
});

test("publishes a leaf beyond the cutoff with an honest omitted count and unchanged id", async () => {
  const started = await startBridge();
  try {
    const { ctx, session, navigations } = commandContext(started.fake);
    ctx.sessionManager.getTree = () => Array.from({ length: 205 }, (_, index) => ({
      entry: { type: "message", id: `entry-${index}`, message: { role: "user", content: index === 204 ? "repeat" : index === 0 ? "repeat" : `message ${index}` } },
    }));
    session.leafId = "entry-204";
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const { picker } = await started.connection.next((record) => record.type === "tree_picker_open");
    assert.equal(picker.nodes.length, 200);
    assert.equal(picker.omitted, 5);
    assert.deepEqual(picker.nodes.filter((node) => node.current).map((node) => node.entry_id), ["entry-204"]);
    assert.equal(picker.nodes.some((node) => node.entry_id === "entry-199"), false);
    assert.deepEqual(picker.nodes.filter((node) => node.label.startsWith("user: repeat")).map(({ entry_id, label }) => [entry_id, label]), [
      ["entry-0", "user: repeat [entry-0]"], ["entry-204", "user: repeat [entry-2]"],
    ]);
    await started.connection.send({ type: "tree_picker_answer", id: "pick-leaf", picker_id: picker.id, entry_id: "entry-204" });
    assert.deepEqual((await started.connection.next((record) => record.id === "pick-leaf")).result, { accepted: true });
    await running;
    assert.deepEqual(navigations, [{ entryId: "entry-204", options: { summarize: false } }]);
  } finally {
    await started.stop();
  }
});

test("publishes a leaf at the cutoff once without trading a row", async () => {
  const started = await startBridge();
  try {
    const { ctx, session } = commandContext(started.fake);
    ctx.sessionManager.getTree = () => Array.from({ length: 201 }, (_, index) => ({
      entry: { type: "message", id: `entry-${index}`, message: { role: "user", content: `message ${index}` } },
    }));
    session.leafId = "entry-199";
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const { picker } = await started.connection.next((record) => record.type === "tree_picker_open");
    assert.equal(picker.nodes.length, 200);
    assert.equal(picker.omitted, 1);
    assert.equal(picker.nodes.filter((node) => node.entry_id === "entry-199").length, 1);
    assert.deepEqual(picker.nodes.filter((node) => node.current).map((node) => node.entry_id), ["entry-199"]);
    assert.equal(picker.nodes.some((node) => node.entry_id === "entry-200"), false);
    await started.connection.send({ type: "tree_picker_cancel", id: "cancel-cutoff", picker_id: picker.id });
    assert.deepEqual((await started.connection.next((record) => record.id === "cancel-cutoff")).result, { accepted: true });
    await running;
  } finally {
    await started.stop();
  }
});

test("refuses an entry id it never published", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");

    await started.connection.send({
      type: "tree_picker_answer",
      id: "pick-1",
      picker_id: open.picker.id,
      entry_id: "browser-invented",
    });
    const response = await started.connection.next((record) => record.id === "pick-1");
    assert.deepEqual(response.result, { accepted: false });
    assert.deepEqual(navigations, []);

    await started.connection.send({ type: "tree_picker_cancel", id: "pick-2", picker_id: open.picker.id });
    const cancelled = await started.connection.next((record) => record.id === "pick-2");
    assert.deepEqual(cancelled.result, { accepted: true });
    await running;
    assert.deepEqual(navigations, []);
  } finally {
    await started.stop();
  }
});

test("re-checks the session before navigating and refuses when it moved", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations, notices, session } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");

    session.leafId = "e2";
    await started.connection.send({
      type: "tree_picker_answer",
      id: "pick-1",
      picker_id: open.picker.id,
      entry_id: "e1",
    });
    await started.connection.next((record) => record.id === "pick-1");
    await running;

    assert.deepEqual(navigations, []);
    assert.match(notices.at(-1).message, /session moved since the picker opened/);
  } finally {
    await started.stop();
  }
});

test("tells the terminal where to answer and leaves Pi's editor alone", async () => {
  const started = await startBridge();
  try {
    const { ctx, notices } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    await started.connection.next((record) => record.type === "tree_picker_open");

    assert.match(notices[0].message, /herdr-web/);
    assert.match(notices[0].message, /cancels/);

    await started.connection.send({
      type: "tree_picker_cancel",
      id: "pick-1",
      picker_id: (await started.connection.next((record) => record.type === "tree_picker_open")).picker.id,
    });
    await running;
  } finally {
    await started.stop();
  }
});

test("a new Pi run cancels the waiting picker", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    await started.connection.next((record) => record.type === "tree_picker_open");

    await started.fake.emit("agent_start", { type: "agent_start" });
    const closed = await started.connection.next((record) => record.type === "tree_picker_closed");
    assert.equal(closed.outcome, "cancelled");
    await running;
    assert.deepEqual(navigations, []);
  } finally {
    await started.stop();
  }
});

test("re-checks the editor draft before navigating and refuses a late draft", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations, notices } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    const open = await started.connection.next((record) => record.type === "tree_picker_open");

    // The terminal stays usable while the card is open.
    ctx.ui.getEditorText = () => "typed while the card was open";
    await started.connection.send({
      type: "tree_picker_answer",
      id: "pick-1",
      picker_id: open.picker.id,
      entry_id: "e1",
    });
    await started.connection.next((record) => record.id === "pick-1");
    await running;

    assert.deepEqual(navigations, []);
    assert.match(notices.at(-1).message, /Clear the editor draft/);
  } finally {
    await started.stop();
  }
});

test("a session switch closes the open picker", async () => {
  const started = await startBridge();
  try {
    const { ctx, navigations } = commandContext(started.fake);
    const running = started.fake.runCommand("herdr-tree", "", ctx);
    await started.connection.next((record) => record.type === "tree_picker_open");

    await started.fake.emit("session_before_switch", { type: "session_before_switch" });
    const closed = await started.connection.next((record) => record.type === "tree_picker_closed");
    assert.equal(closed.outcome, "cancelled");
    await running;
    assert.deepEqual(navigations, []);
  } finally {
    await started.stop();
  }
});
