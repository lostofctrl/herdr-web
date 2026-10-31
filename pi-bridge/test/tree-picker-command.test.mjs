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
