import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension } from "./helpers.mjs";

const user = (text, id = text) => ({ type: "message", id, message: { role: "user", content: text } });
const assistant = (text, stopReason = "stop") => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });

async function setup(t, branch = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-context-test-"));
  const fake = createFakeExtension({ entries: [user("wrong abandoned branch")] });
  let active = branch;
  let session = "session-a";
  let leaf = "leaf-a";
  Object.assign(fake.ctx.sessionManager, {
    getBranch: () => active,
    getSessionId: () => session,
    getLeafId: () => leaf,
  });
  const bridge = createPiBridge(fake.pi, { socketPath: path.join(dir, "pane.sock") });
  await fake.emit("session_start");
  const socket = await connect(bridge.socketPath);
  t.after(async () => { await socket.close(); await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  return { fake, socket, setBranch: (value) => { active = value; }, setLeaf: (value) => { leaf = value; }, setSession: (value) => { session = value; } };
}

async function context(socket, id = "context") {
  socket.send({ type: "get_conversation", id, schema_version: 1 });
  return socket.next((r) => r.type === "conversation_update" && r.request_id === id);
}

test("conversation uses active ancestry and returns distinct first/latest public exchanges separately from the legacy snapshot", async (t) => {
  const { socket } = await setup(t, [user("first"), assistant("answer one"), user("middle"), assistant("answer two"), user("current")]);
  const hello = await socket.next((r) => r.type === "hello");
  assert.equal(hello.capabilities.conversation_context, true);
  const result = await context(socket);
  assert.equal(result.schema_version, 1);
  assert.equal(result.session_id, "session-a");
  assert.equal(result.leaf_id, "leaf-a");
  assert.equal(result.availability, "ready");
  assert.deepEqual(result.exchanges.map((e) => [e.user, e.assistant, e.status]), [["first", "answer one", "complete"], ["current", "", "pending"]]);
  assert.ok(result.epoch.length > 0);
  assert.ok(result.selection_generation >= 1);
  assert.ok(result.revision >= 1);
  socket.send({ type: "get_snapshot", id: "legacy" });
  const legacy = await socket.next((r) => r.type === "response" && r.id === "legacy");
  assert.equal("conversation" in legacy.result, false);
});


test("public user/assistant shapes preserve interrupted text without leaking tools, thinking, custom payloads or summaries", async (t) => {
  const { socket, setBranch } = await setup(t, [
    user([{ type: "text", text: "visible user" }, { type: "image", data: "SECRET" }]),
    { type: "custom_message", message: { role: "user", content: "SECRET custom" } },
    { type: "compaction", summary: "SECRET summary" },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET thoughts" }, { type: "text", text: "public partial" }] , stopReason: "aborted" } },
    { type: "message", message: { role: "toolResult", content: "SECRET tool" } },
    assistant("", "toolUse"),
  ]);
  const one = await context(socket);
  assert.equal(one.exchanges.length, 1);
  assert.deepEqual([one.exchanges[0].user, one.exchanges[0].assistant, one.exchanges[0].status], ["visible user", "public partial", "aborted"]);
  assert.ok(!JSON.stringify(one).includes("SECRET"));
  setBranch([user("one"), assistant("part one", "toolUse"), assistant("part two", "error"), user("unanswered")]);
  const two = await context(socket, "two");
  assert.deepEqual(two.exchanges.map((e) => [e.assistant, e.status]), [["part one\n\npart two", "error"], ["", "pending"]]);
  setBranch([]);
  assert.deepEqual((await context(socket, "empty")).exchanges, []);
});

test("completion refresh runs after Pi persists message_end, and selection immediately invalidates queued work including away/back", async (t) => {
  const { socket, fake, setBranch, setLeaf } = await setup(t, [user("question")]);
  const initial = await context(socket);
  const answer = assistant("persisted answer");
  await fake.emit("message_end", { message: answer.message });
  // This is the real Pi ordering: extension handlers finish before appendMessage.
  setBranch([user("question"), answer]);
  const completed = await socket.next((r) => r.type === "conversation_update" && r.revision > initial.revision && r.exchanges[0]?.assistant === "persisted answer");
  await fake.emit("message_end", { message: assistant("stale").message });
  await fake.emit("session_before_tree");
  const invalid = await socket.next((r) => r.type === "conversation_update" && r.availability === "unavailable");
  assert.ok(invalid.selection_generation > completed.selection_generation);
  setLeaf("leaf-b"); setBranch([user("branch b")]);
  await fake.emit("session_tree");
  await fake.emit("session_before_tree");
  setLeaf("leaf-a"); setBranch([user("back to a")]);
  await fake.emit("session_tree");
  const back = await context(socket, "back");
  assert.ok(back.selection_generation > invalid.selection_generation);
  assert.equal(back.exchanges[0].user, "back to a");
  await fake.emit("agent_start");
  const running = await socket.next((r) => r.type === "conversation_update" && r.exchanges[0]?.status === "running");
  assert.ok(running.revision > back.revision);
});


test("actual encoded conversation caps prioritize latest tails, preserve Unicode and flag every truncation", async (t) => {
  const huge = "😀\"\n\u0000".repeat(20000);
  const { socket, setBranch, setSession } = await setup(t, [user("FIRST-HEAD" + huge), assistant("FIRST-ANSWER" + huge), user(huge + "LATEST-TAIL"), assistant(huge + "ANSWER-TAIL")]);
  const result = await context(socket);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  for (const exchange of result.exchanges) {
    for (const key of ["user", "assistant"]) {
      assert.ok(Buffer.byteLength(exchange[key]) <= 16384);
      assert.equal(exchange[key + "_truncated"], true);
      assert.equal(exchange[key].isWellFormed(), true);
    }
  }
  assert.ok(result.exchanges[1].user.endsWith("LATEST-TAIL"));
  assert.ok(result.exchanges[1].assistant.endsWith("ANSWER-TAIL"));
  assert.ok(result.exchanges[0].user.startsWith("FIRST-HEAD") || result.exchanges[0].user === "");
  const latestBytes = Buffer.byteLength(result.exchanges[1].user) + Buffer.byteLength(result.exchanges[1].assistant);
  assert.ok(latestBytes > 20000, "latest fields receive allocation before first");
  setSession("identity".repeat(2000));
  const unavailable = await context(socket, "metadata");
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.reason, "metadata_too_large");
  assert.equal(unavailable.session_id, null);
  assert.deepEqual(unavailable.exchanges, []);
  setSession("normal"); setBranch([user("x".repeat(16384)), assistant("y".repeat(16384))]);
  const exact = await context(socket, "exact");
  assert.equal(Buffer.byteLength(exact.exchanges[0].user), 16384);
  assert.equal(exact.exchanges[0].user_truncated, false);
});


test("session replacement, compaction and authority loss refresh separately, with old-client/new-bridge compatibility", async (t) => {
  const { socket, fake, setBranch, setSession } = await setup(t, [user("before")]);
  const initial = await context(socket);
  for (const event of ["session_before_compact", "session_before_fork", "session_before_switch"]) {
    await fake.emit(event);
    const invalid = await socket.next((r) => r.type === "conversation_update" && r.availability === "unavailable" && r.selection_generation > initial.selection_generation);
    assert.equal(invalid.availability, "unavailable");
    assert.deepEqual(invalid.exchanges, []);
    assert.ok(invalid.selection_generation > initial.selection_generation);
    // If a later extension cancels the operation, explicit resync reads current authority.
    assert.equal((await context(socket, event + "-cancel-resync")).availability, "ready");
    await fake.emit(event === "session_before_compact" ? "session_compact_failed" : "session_start");
    assert.equal((await context(socket, event + "-after")).availability, "ready");
  }
  setSession("resumed"); setBranch([user("resumed question")]);
  await fake.emit("session_start", { reason: "resume" });
  const resumed = await context(socket, "resume");
  assert.equal(resumed.session_id, "resumed");
  assert.equal(resumed.exchanges[0].user, "resumed question");
  assert.ok(resumed.selection_generation > initial.selection_generation);
  await fake.emit("session_before_compact");
  setBranch([user("kept question"), { type: "compaction", summary: "not public" }]);
  await fake.emit("session_compact");
  assert.equal((await context(socket, "compact")).exchanges[0].user, "kept question");
  fake.ctx.sessionManager.getBranch = () => { throw new Error("authority disappeared"); };
  const lost = await context(socket, "lost");
  assert.equal(lost.availability, "unavailable");
  assert.deepEqual(lost.exchanges, []);
  delete fake.ctx.sessionManager.getBranch;
  await fake.emit("session_start", { reason: "reload" });
  assert.equal((await socket.next((r) => r.type === "hello" && r.capabilities.conversation_context === false)).protocol_version, 1);
  socket.send({ type: "get_snapshot", id: "old-client" });
  assert.equal((await socket.next((r) => r.type === "response" && r.id === "old-client")).ok, true);
  socket.send({ type: "get_conversation", id: "unsupported", schema_version: 2 });
  assert.equal((await socket.next((r) => r.type === "response" && r.id === "unsupported")).ok, false);
});
