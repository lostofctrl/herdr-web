import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension } from "./helpers.mjs";

const PANE_ID = "pane-questions";

const PROMPT = {
  toolCallId: "tool-1",
  questions: [
    {
      question: "Which layout should the card use?",
      header: "Layout",
      multiSelect: false,
      options: [
        { label: "Stack", description: "One column", hasPreview: true },
        { label: "Split", description: "Two columns", hasPreview: false },
      ],
    },
    {
      question: "Which surfaces ship?",
      header: "Surfaces",
      multiSelect: true,
      options: [
        { label: "Phone", description: "Touch card", hasPreview: false },
        { label: "Desktop", description: "Wide card", hasPreview: false },
      ],
    },
  ],
};

const TOOL_ARGS = {
  questions: [
    {
      question: PROMPT.questions[0].question,
      header: "Layout",
      multiSelect: false,
      options: [
        { label: "Stack", description: "One column", preview: "<Stack preview>" },
        { label: "Split", description: "Two columns" },
      ],
    },
    {
      question: PROMPT.questions[1].question,
      header: "Surfaces",
      multiSelect: true,
      options: [
        { label: "Phone", description: "Touch card" },
        { label: "Desktop", description: "Wide card" },
      ],
    },
  ],
};

async function startBridge() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-test-"));
  const fake = createFakeExtension();
  const bridge = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: PANE_ID, XDG_RUNTIME_DIR: runtimeDir },
    exec: fake.pi.exec,
  });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  const connection = await connect(path.join(runtimeDir, "pi-bridge", `${PANE_ID}.sock`));
  await connection.next((record) => record.type === "hello");
  await connection.next((record) => record.type === "state");
  await connection.next((record) => record.type === "catalog");
  return {
    fake,
    bridge,
    connection,
    runtimeDir,
    async cleanup() {
      await connection.close();
      await bridge.stop();
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}

async function openQuestionnaire(fake, prompt = PROMPT) {
  await fake.emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: prompt.toolCallId,
    toolName: "ask_user_question",
    args: TOOL_ARGS,
  });
  fake.pi.events.emit("rpiv:ask-user:prompt", prompt);
}

function acceptAnswers(fake) {
  const seen = [];
  fake.pi.events.on("rpiv:ask-user:answer", (payload) => {
    seen.push(payload);
    fake.pi.events.emit("rpiv:ask-user:answer-result", {
      ok: true,
      requestId: payload.requestId,
      toolCallId: payload.toolCallId,
    });
  });
  return seen;
}

test("relays rpiv prompt as a question dialog with descriptions, previews and multi-select", async () => {
  const started = await startBridge();

  await openQuestionnaire(started.fake);

  const opened = await started.connection.next((record) => record.type === "dialog_open");
  assert.equal(opened.dialog.id, "tool-1");
  assert.equal(opened.dialog.kind, "question");
  assert.equal(opened.dialog.timeout_ms, null);
  assert.equal(opened.dialog.questions.length, 2);
  assert.deepEqual(opened.dialog.questions[0], {
    question: "Which layout should the card use?",
    header: "Layout",
    multiSelect: false,
    options: [
      { label: "Stack", description: "One column", preview: "<Stack preview>" },
      { label: "Split", description: "Two columns", preview: "" },
    ],
  });
  assert.equal(opened.dialog.questions[1].multiSelect, true);
  assert.deepEqual(
    opened.dialog.questions[1].options.map((option) => option.label),
    ["Phone", "Desktop"],
  );

  const state = await started.connection.next(
    (record) => record.type === "state" && record.busy === "dialog",
  );
  assert.equal(state.busy, "dialog");

  started.connection.send({ type: "get_snapshot", id: "snap-1" });
  const snapshot = await started.connection.next(
    (record) => record.type === "response" && record.id === "snap-1",
  );
  assert.equal(snapshot.result.dialogs.length, 1);
  assert.equal(snapshot.result.dialogs[0].id, "tool-1");

  await started.cleanup();
});

test("dialog_answer relays rpiv answer, wins first, and closes the card as answered", async () => {
  const started = await startBridge();
  const seen = acceptAnswers(started.fake);
  await openQuestionnaire(started.fake);
  await started.connection.next((record) => record.type === "dialog_open");

  started.connection.send({
    type: "dialog_answer",
    id: "answer-1",
    dialog_id: "tool-1",
    value: {
      answers: [
        { questionIndex: 0, optionIndexes: [0], text: "  extra detail  " },
        { questionIndex: 1, optionIndexes: [0, 1] },
      ],
    },
  });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "answer-1",
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { accepted: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolCallId, "tool-1");
  assert.equal(typeof seen[0].requestId, "string");
  assert.deepEqual(seen[0].answers, [
    { questionIndex: 0, optionIndexes: [0], text: "extra detail" },
    { questionIndex: 1, optionIndexes: [0, 1] },
  ]);

  const closed = await started.connection.next((record) => record.type === "dialog_closed");
  assert.equal(closed.id, "tool-1");
  assert.equal(closed.resolution, "answered");

  started.connection.send({ type: "get_snapshot", id: "snap-2" });
  const snapshot = await started.connection.next(
    (record) => record.type === "response" && record.id === "snap-2",
  );
  assert.deepEqual(snapshot.result.dialogs, []);

  await started.cleanup();
});

test("a terminal answer wins the race and the phone answer is not accepted", async () => {
  const started = await startBridge();
  await openQuestionnaire(started.fake);
  await started.connection.next((record) => record.type === "dialog_open");

  started.fake.pi.events.on("rpiv:ask-user:answer", (payload) => {
    // The terminal settled the questionnaire first; rpiv refuses the late answer.
    started.fake.pi.events.emit("rpiv:ask-user:answer-result", {
      ok: false,
      code: "not_found",
      reason: "already answered",
      requestId: payload.requestId,
      toolCallId: payload.toolCallId,
    });
  });

  started.connection.send({
    type: "dialog_answer",
    id: "answer-late",
    dialog_id: "tool-1",
    value: { answers: [{ questionIndex: 0, optionIndexes: [0] }] },
  });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "answer-late",
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { accepted: false });

  started.fake.pi.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "tool-1" });
  const closed = await started.connection.next((record) => record.type === "dialog_closed");
  assert.equal(closed.id, "tool-1");
  assert.equal(closed.resolution, "terminal");

  await started.cleanup();
});

test("a cancel maps to cancel:true and closes the card as cancelled", async () => {
  const started = await startBridge();
  const seen = acceptAnswers(started.fake);
  await openQuestionnaire(started.fake);
  await started.connection.next((record) => record.type === "dialog_open");

  started.connection.send({
    type: "dialog_answer",
    id: "answer-cancel",
    dialog_id: "tool-1",
    cancel: true,
  });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "answer-cancel",
  );
  assert.deepEqual(response.result, { accepted: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cancel, true);
  assert.equal(seen[0].answers, undefined);

  const closed = await started.connection.next((record) => record.type === "dialog_closed");
  assert.equal(closed.resolution, "cancelled");

  await started.cleanup();
});

test("an answer from the terminal removes the card without a phone request", async () => {
  const started = await startBridge();
  await openQuestionnaire(started.fake);
  await started.connection.next((record) => record.type === "dialog_open");

  started.fake.pi.events.emit("rpiv:ask-user:blocked", { active: true, toolCallId: "tool-1" });
  started.fake.pi.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "tool-1" });

  const closed = await started.connection.next((record) => record.type === "dialog_closed");
  assert.equal(closed.id, "tool-1");
  assert.equal(closed.resolution, "terminal");
  const idle = await started.connection.next(
    (record) => record.type === "state" && record.busy === "idle",
  );
  assert.equal(idle.busy, "idle");

  await started.cleanup();
});
