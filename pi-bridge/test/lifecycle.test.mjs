import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension, expectNoRecord } from "./helpers.mjs";

const PANE_ID = "workspace-1:tab-2:pane-3";

async function makeEnv() {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-test-"));
  return {
    runtimeDir,
    env: { HERDR_PANE_ID: PANE_ID, XDG_RUNTIME_DIR: runtimeDir },
  };
}

function socketPathFor(runtimeDir) {
  return path.join(runtimeDir, "pi-bridge", `${PANE_ID}.sock`);
}

async function startBridge(options = {}) {
  const fake = createFakeExtension(options);
  const dirs = options.dirs ?? (await makeEnv());
  const bridge = createPiBridge(fake.pi, { env: dirs.env, exec: fake.pi.exec });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  return { fake, bridge, socketPath: socketPathFor(dirs.runtimeDir), ...dirs };
}

async function stopBridge(started) {
  await started.bridge.stop();
  await rm(started.runtimeDir, { recursive: true, force: true });
}

test("stays inert outside a Herdr pane", async () => {
  const fake = createFakeExtension();
  const bridge = createPiBridge(fake.pi, { env: {} });

  await fake.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(fake.registered.length, 0, "no extension handlers registered");
  assert.equal(bridge.socketPath, null);
  assert.equal(bridge.isRunning(), false);
});

test("uses the contract socket path and falls back to the OS temp directory", () => {
  const fake = createFakeExtension();
  const withRuntimeDir = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: "pane-9", XDG_RUNTIME_DIR: "/run/user/1000" },
  });
  assert.equal(withRuntimeDir.socketPath, "/run/user/1000/pi-bridge/pane-9.sock");

  const withoutRuntimeDir = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: "pane-9" },
  });
  assert.equal(
    withoutRuntimeDir.socketPath,
    path.join(os.tmpdir(), `pi-bridge-${process.getuid()}`, "pane-9.sock"),
  );
});

test("hello advertises protocol version 1 and capabilities, then sends the snapshot", async () => {
  const started = await startBridge({
    entries: [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
      },
    ],
  });
  const connection = await connect(started.socketPath);

  const hello = await connection.next((record) => record.type === "hello");
  assert.equal(hello.protocol_version, 1);
  assert.deepEqual(hello.capabilities, {
    generic_dialogs: true,
    assistant_message: true,
    list_files: true,
    skills_catalog: true,
    conversation_snapshot: false,
  });

  const state = await connection.next((record) => record.type === "state");
  assert.equal(state.busy, "idle");
  assert.equal(state.cwd, "/work/repo");
  assert.deepEqual(state.model, { provider: "anthropic", id: "claude-sonnet-4" });
  assert.equal(state.thinking_level, "medium");
  assert.deepEqual(state.models, [
    { provider: "anthropic", id: "claude-sonnet-4", label: "claude-sonnet-4" },
    { provider: "anthropic", id: "claude-opus-4", label: "claude-opus-4" },
  ]);
  assert.ok(state.thinking_levels.includes("high"));

  const catalog = await connection.next((record) => record.type === "catalog");
  assert.deepEqual(
    catalog.commands.map((command) => command.name),
    ["compact", "deploy"],
  );
  assert.deepEqual(
    catalog.skills.map((skill) => skill.name),
    ["brainstorm"],
  );
  assert.equal(catalog.skills_note, undefined);

  const assistant = await connection.next((record) => record.type === "assistant_message");
  assert.equal(assistant.text, "previous answer");

  await connection.close();
  await stopBridge(started);
});

test("get_snapshot returns state, catalog, dialogs and the latest assistant message", async () => {
  const started = await startBridge({
    entries: [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "older" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "latest answer" },
          ],
        },
      },
    ],
  });
  const connection = await connect(started.socketPath);
  await connection.next((record) => record.type === "hello");

  connection.send({ type: "get_snapshot", id: "snap-1" });
  const response = await connection.next(
    (record) => record.type === "response" && record.id === "snap-1",
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.state.busy, "idle");
  assert.deepEqual(
    response.result.catalog.commands.map((command) => command.name),
    ["compact", "deploy"],
  );
  assert.deepEqual(response.result.dialogs, []);
  assert.equal(response.result.assistant_message, "latest answer");

  await connection.close();
  await stopBridge(started);
});

test("catalog lists a skill from pi.getCommands() once and advertises the capability", async () => {
  const started = await startBridge();
  const connection = await connect(started.socketPath);
  const hello = await connection.next((record) => record.type === "hello");
  assert.equal(hello.capabilities.skills_catalog, true);

  connection.send({ type: "get_snapshot", id: "snap-skills" });
  const response = await connection.next(
    (record) => record.type === "response" && record.id === "snap-skills",
  );
  assert.deepEqual(response.result.catalog.skills, [
    { name: "brainstorm", description: "Brainstorm ideas", source: "skill" },
  ]);
  assert.deepEqual(
    response.result.catalog.commands.map((command) => command.name),
    ["compact", "deploy"],
  );
  assert.equal(response.result.catalog.skills_note, undefined);

  await connection.close();
  await stopBridge(started);
});

test("a host without pi.getCommands() hides skills_catalog and explains why", async () => {
  const started = await startBridge({ commands: null });
  const connection = await connect(started.socketPath);
  await connection.next((record) => record.type === "hello");

  connection.send({ type: "get_snapshot", id: "snap-skills" });
  const response = await connection.next(
    (record) => record.type === "response" && record.id === "snap-skills",
  );
  assert.deepEqual(response.result.catalog.skills, []);
  assert.match(response.result.catalog.skills_note, /getCommands/);

  await connection.close();
  await stopBridge(started);
});

test("state follows agent start/end and dialog open/close", async () => {
  const started = await startBridge();
  const connection = await connect(started.socketPath);
  await connection.next((record) => record.type === "hello");

  await started.fake.emit("agent_start", { type: "agent_start" });
  assert.equal((await connection.next((r) => r.type === "state" && r.busy === "busy")).busy, "busy");

  await started.fake.emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal((await connection.next((r) => r.type === "state" && r.busy === "idle")).busy, "idle");

  await started.fake.emit("ui_prompt_start", {
    type: "ui_prompt_start",
    reason: "ui_prompt",
    kind: "select",
    title: "Pick one",
  });
  assert.equal((await connection.next((r) => r.type === "state" && r.busy === "dialog")).busy, "dialog");

  await started.fake.emit("ui_prompt_end", {
    type: "ui_prompt_end",
    reason: "ui_prompt",
    kind: "select",
  });
  assert.equal((await connection.next((r) => r.type === "state" && r.busy === "idle")).busy, "idle");

  await connection.close();
  await stopBridge(started);
});

test("assistant_message is published only for completed assistant messages", async () => {
  const started = await startBridge();
  const connection = await connect(started.socketPath);
  await connection.next((record) => record.type === "hello");

  await started.fake.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "do not publish" }] },
  });
  await expectNoRecord(connection, (record) => record.type === "assistant_message");

  await started.fake.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "first paragraph" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "text", text: "second paragraph" },
      ],
    },
  });
  const message = await connection.next((record) => record.type === "assistant_message");
  assert.equal(message.text, "first paragraph\nsecond paragraph");

  await connection.close();
  await stopBridge(started);
});

test("removes its socket on shutdown and replaces a stale socket on restart", async () => {
  const dirs = await makeEnv();
  const socketPath = socketPathFor(dirs.runtimeDir);
  const first = await startBridge({ dirs });
  assert.equal(existsSync(socketPath), true);

  await first.fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(existsSync(socketPath), false, "socket removed on shutdown");

  // A crashed Pi leaves the socket file behind; the next start must take it over.
  await mkdir(path.dirname(socketPath), { recursive: true });
  await writeFile(socketPath, "");
  const second = await startBridge({ dirs });
  const connection = await connect(socketPath);
  const hello = await connection.next((record) => record.type === "hello");
  assert.equal(hello.protocol_version, 1);
  assert.equal(second.bridge.isRunning(), true);

  await connection.close();
  await stopBridge(second);
});

test("does not steal a socket from a live bridge", async () => {
  const dirs = await makeEnv();
  const first = await startBridge({ dirs });

  const fake = createFakeExtension();
  const second = createPiBridge(fake.pi, { env: dirs.env, exec: fake.pi.exec });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(second.isRunning(), false, "second bridge refuses to take over a live socket");
  const connection = await connect(socketPathFor(dirs.runtimeDir));
  await connection.next((record) => record.type === "hello");
  await connection.close();

  await stopBridge(first);
});

test("rejects a pane id that could escape the runtime directory", async () => {
  const fake = createFakeExtension();
  const bridge = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: "../../etc/passwd", XDG_RUNTIME_DIR: "/tmp" },
  });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(bridge.socketPath, null);
  assert.equal(bridge.isRunning(), false);
});
