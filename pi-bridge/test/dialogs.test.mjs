import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension } from "./helpers.mjs";

async function start(t, configure = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-dialog-test-"));
  const fake = createFakeExtension();
  configure(fake);
  const original = fake.ctx.ui.select;
  const bridge = createPiBridge(fake.pi, { socketPath: path.join(dir, "pane.sock") });
  t.after(async () => { await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  await fake.emit("session_start");
  const connection = await connect(bridge.socketPath);
  t.after(() => connection.close());
  const hello = await connection.next((r) => r.type === "hello");
  return { fake, bridge, connection, hello, original };
}

test("installs generic dialogs on Pi's shared ui and advertises the capability", async (t) => {
  const { fake, hello, original } = await start(t);
  assert.equal(hello.capabilities.generic_dialogs, true);
  assert.notEqual(fake.ctx.ui.select, original);
});

function terminal(fake, kind) {
  let resolve;
  let reject;
  const seen = [];
  fake.ctx.ui[kind] = (title, argument, opts) => {
    seen.push({ title, argument, opts });
    return new Promise((res, rej) => {
      resolve = res; reject = rej;
      opts.signal?.addEventListener("abort", () => res(kind === "confirm" ? false : undefined), { once: true });
    });
  };
  return { seen, answer: (value) => resolve(value), fail: (error) => reject(error) };
}

for (const [kind, argument, value] of [
  ["select", ["One", "Two"], "Two"],
  ["confirm", "Ship it?", false],
  ["input", "Your name", "Alice"],
]) {
  test(`phone ${kind} answer settles the caller, aborts terminal, and refuses late answers`, async (t) => {
    let tui;
    const { fake, connection } = await start(t, (fake) => { tui = terminal(fake, kind); });
    const caller = fake.ctx.ui[kind]("Choose", argument, { timeout: 5000 });
    const { dialog } = await connection.next((r) => r.type === "dialog_open");
    assert.equal(dialog.kind, kind);
    assert.equal(dialog.title, "Choose");
    assert.equal(dialog.timeout_ms, 5000);
    if (kind === "select") assert.deepEqual(dialog.options, [{ label: "One" }, { label: "Two" }]);
    if (kind === "confirm") assert.equal(dialog.message, "Ship it?");
    if (kind === "input") assert.equal(dialog.placeholder, "Your name");
    assert.equal(tui.seen[0].opts.timeout, 5000);
    assert.equal(tui.seen[0].opts.signal.aborted, false);
    connection.send({ type: "dialog_answer", id: "phone", dialog_id: dialog.id, value });
    assert.equal((await connection.next((r) => r.id === "phone")).result.accepted, true);
    assert.equal(await caller, value);
    assert.equal(tui.seen[0].opts.signal.aborted, true);
    assert.equal((await connection.next((r) => r.type === "dialog_closed")).resolution, "answered");
    connection.send({ type: "dialog_answer", id: "late", dialog_id: dialog.id, value });
    assert.equal((await connection.next((r) => r.id === "late")).result.accepted, false);
    connection.send({ type: "get_snapshot", id: "snapshot" });
    assert.deepEqual((await connection.next((r) => r.id === "snapshot")).result.dialogs, []);
  });
}

test("terminal answer closes every client and keeps the winning value", async (t) => {
  let tui;
  const { fake, connection, bridge } = await start(t, (fake) => { tui = terminal(fake, "select"); });
  const desktop = await connect(bridge.socketPath);
  t.after(() => desktop.close());
  const caller = fake.ctx.ui.select("Pick", ["a", "b"]);
  const { dialog } = await connection.next((r) => r.type === "dialog_open");
  await desktop.next((r) => r.type === "dialog_open");
  tui.answer("a");
  assert.equal(await caller, "a");
  for (const client of [connection, desktop]) {
    const closed = await client.next((r) => r.type === "dialog_closed");
    assert.equal(closed.id, dialog.id);
    assert.equal(closed.resolution, "terminal");
  }
  connection.send({ type: "dialog_answer", id: "late-terminal", dialog_id: dialog.id, value: "b" });
  assert.equal((await connection.next((r) => r.id === "late-terminal")).result.accepted, false);
});

test("Pi owns timeout: card stays open until Pi resolves its terminal dialog", async (t) => {
  let tui;
  const { fake, connection } = await start(t, (fake) => { tui = terminal(fake, "input"); });
  const caller = fake.ctx.ui.input("Name", "Name", { timeout: 1 });
  await connection.next((r) => r.type === "dialog_open");
  await new Promise((resolve) => setTimeout(resolve, 20));
  connection.send({ type: "get_snapshot", id: "not-yet-expired" });
  const snapshot = (await connection.next((r) => r.id === "not-yet-expired")).result;
  assert.equal(snapshot.dialogs.length, 1);
  assert.equal(snapshot.dialogs[0].timeout_ms, 0);
  tui.answer(undefined); // Pi's component countdown expires, not a bridge timer.
  assert.equal(await caller, undefined);
  assert.equal((await connection.next((r) => r.type === "dialog_closed")).resolution, "timeout");
});

test("combined caller AbortSignal cancels both surfaces and pre-aborted calls never open a card", async (t) => {
  let tui;
  const { fake, connection } = await start(t, (fake) => { tui = terminal(fake, "confirm"); });
  const controller = new AbortController();
  const caller = fake.ctx.ui.confirm("Allow?", "Permission", { signal: controller.signal });
  await connection.next((r) => r.type === "dialog_open");
  controller.abort();
  assert.equal(await caller, false);
  assert.equal(tui.seen[0].opts.signal.aborted, true);
  assert.equal((await connection.next((r) => r.type === "dialog_closed")).resolution, "cancelled");
  assert.equal(await fake.ctx.ui.confirm("Aborted", "", { signal: controller.signal }), false);
  assert.equal(tui.seen.length, 1);
});

test("invalid phone values leave the dialog open; Cancel returns Pi's cancellation value", async (t) => {
  const { fake, connection } = await start(t, (fake) => terminal(fake, "select"));
  const caller = fake.ctx.ui.select("Pick", ["a"]);
  const { dialog } = await connection.next((r) => r.type === "dialog_open");
  connection.send({ type: "dialog_answer", id: "invalid", dialog_id: dialog.id, value: "not an option" });
  assert.equal((await connection.next((r) => r.id === "invalid")).result.accepted, false);
  connection.send({ type: "dialog_answer", id: "cancel", dialog_id: dialog.id, cancel: true });
  assert.equal((await connection.next((r) => r.id === "cancel")).result.accepted, true);
  assert.equal(await caller, undefined);
  assert.equal((await connection.next((r) => r.type === "dialog_closed")).resolution, "cancelled");
});

test("failed install rolls back, advertises false, notifies once and preserves terminal/Key Bar events", async (t) => {
  const notices = [];
  let originalSelect;
  const { fake, connection, hello } = await start(t, (fake) => {
    fake.ctx.ui.notify = (...args) => notices.push(args);
    originalSelect = fake.ctx.ui.select;
    Object.defineProperty(fake.ctx.ui, "input", { writable: false });
  });
  assert.equal(hello.capabilities.generic_dialogs, false);
  assert.equal(fake.ctx.ui.select, originalSelect);
  assert.equal(await fake.ctx.ui.confirm("Terminal still works", ""), false);
  await fake.emit("session_start");
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /Native Cards are disabled/);
  await fake.emit("ui_prompt_start");
  assert.equal((await connection.next((r) => r.type === "state" && r.busy === "dialog")).busy, "dialog");
});

test("terminal failures close cards and propagate; shutdown aborts pending dialogs and restores UI", async (t) => {
  let tui;
  const { fake, connection, bridge, original } = await start(t, (fake) => { tui = terminal(fake, "input"); });
  const caller = fake.ctx.ui.input("Broken", "");
  const rejected = assert.rejects(caller, /terminal failed/);
  await connection.next((r) => r.type === "dialog_open");
  tui.fail(new Error("terminal failed"));
  await rejected;
  await connection.next((r) => r.type === "dialog_closed");
  const pending = fake.ctx.ui.input("Pending", "");
  await connection.next((r) => r.type === "dialog_open");
  await bridge.stop();
  assert.equal(await pending, undefined);
  assert.equal(tui.seen.at(-1).opts.signal.aborted, true);
  assert.equal(fake.ctx.ui.select, original);
});
