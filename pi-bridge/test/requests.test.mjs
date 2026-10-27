import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiBridge } from "../src/index.ts";
import { connect, createFakeExtension, expectNoRecord } from "./helpers.mjs";

const PANE_ID = "pane-requests";

async function startBridge(options = {}) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-test-"));
  const fake = createFakeExtension(options);
  const bridge = createPiBridge(fake.pi, {
    env: { HERDR_PANE_ID: PANE_ID, XDG_RUNTIME_DIR: runtimeDir },
    exec: fake.pi.exec,
  });
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  const connection = await connect(path.join(runtimeDir, "pi-bridge", `${PANE_ID}.sock`));
  await connection.next((record) => record.type === "hello");
  // Drain the snapshot the bridge sends on connect so later assertions see broadcasts.
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

test("set_model changes Pi, echoes the request id and broadcasts the new state", async () => {
  const started = await startBridge();
  started.connection.send({
    type: "set_model",
    id: "req-model",
    provider: "anthropic",
    model: "claude-opus-4",
  });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "req-model",
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.state.model, {
    provider: "anthropic",
    id: "claude-opus-4",
  });
  assert.equal(started.fake.calls.setModel.length, 1);
  assert.equal(started.fake.calls.setModel[0].id, "claude-opus-4");

  const broadcast = await started.connection.next((record) => record.type === "state");
  assert.deepEqual(broadcast.model, { provider: "anthropic", id: "claude-opus-4" });

  await started.cleanup();
});

test("set_model reports an unknown model without changing Pi", async () => {
  const started = await startBridge();
  started.connection.send({
    type: "set_model",
    id: "req-missing",
    provider: "anthropic",
    model: "does-not-exist",
  });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "req-missing",
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown model/);
  assert.equal(started.fake.calls.setModel.length, 0);

  await started.cleanup();
});

test("set_thinking_level validates and applies the level", async () => {
  const started = await startBridge();
  started.connection.send({ type: "set_thinking_level", id: "level-1", level: "high" });

  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "level-1",
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.state.thinking_level, "high");
  assert.deepEqual(started.fake.calls.setThinkingLevel, ["high"]);

  started.connection.send({ type: "set_thinking_level", id: "level-2", level: "turbo" });
  const invalid = await started.connection.next(
    (record) => record.type === "response" && record.id === "level-2",
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /invalid thinking level/);
  assert.deepEqual(started.fake.calls.setThinkingLevel, ["high"]);

  await started.cleanup();
});

test("list_files lists tracked files, filters by query and caps the limit", async () => {
  const tracked = [
    "src/App.tsx",
    "src/bridge.ts",
    "src/pi/client.ts",
    "docs/readme.md",
    "README.md",
  ];
  const started = await startBridge({
    execResult: { stdout: `${tracked.join("\0")}\0`, stderr: "", code: 0, killed: false },
  });

  started.connection.send({ type: "list_files", id: "files-1", query: "src/", limit: 2 });
  const limited = await started.connection.next(
    (record) => record.type === "response" && record.id === "files-1",
  );
  assert.equal(limited.ok, true);
  assert.deepEqual(limited.result.files, [{ path: "src/App.tsx" }, { path: "src/bridge.ts" }]);

  started.connection.send({ type: "list_files", id: "files-2", query: "PI/C", limit: 10 });
  const filtered = await started.connection.next(
    (record) => record.type === "response" && record.id === "files-2",
  );
  assert.deepEqual(filtered.result.files, [{ path: "src/pi/client.ts" }]);

  const execCall = started.fake.calls.exec.at(-1);
  assert.equal(execCall.command, "git");
  assert.deepEqual(execCall.args, ["ls-files", "-z"]);
  assert.equal(execCall.options.cwd, "/work/repo");

  await started.cleanup();
});

test("list_files clamps an oversized limit", async () => {
  const tracked = Array.from({ length: 250 }, (_, index) => `file-${String(index).padStart(3, "0")}.ts`);
  const started = await startBridge({
    execResult: { stdout: `${tracked.join("\0")}\0`, stderr: "", code: 0, killed: false },
  });

  started.connection.send({ type: "list_files", id: "files-max", query: "", limit: 10_000 });
  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "files-max",
  );
  assert.equal(response.result.files.length, 200);
  assert.equal(response.result.files[0].path, "file-000.ts");

  await started.cleanup();
});

test("reports a failed git listing as an error response", async () => {
  const started = await startBridge({ execError: "fatal: not a git repository" });
  started.connection.send({ type: "list_files", id: "files-err", query: "src" });
  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "files-err",
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /file listing failed/);
  assert.match(response.error, /not a git repository/);

  await started.cleanup();
});

test("dialog_answer is accepted but settles nothing without Native Cards", async () => {
  const started = await startBridge();
  started.connection.send({ type: "dialog_answer", id: "answer-1", dialog_id: "d1", value: "a" });
  const response = await started.connection.next(
    (record) => record.type === "response" && record.id === "answer-1",
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { accepted: false });

  await started.cleanup();
});

test("correlates responses by id and rejects unknown or malformed requests", async () => {
  const started = await startBridge();
  const { connection } = started;

  connection.send({ type: "get_snapshot", id: "a" });
  connection.send({ type: "get_snapshot", id: "b" });
  const first = await connection.next((record) => record.type === "response" && record.id === "a");
  const second = await connection.next((record) => record.type === "response" && record.id === "b");
  assert.equal(first.id, "a");
  assert.equal(second.id, "b");

  connection.send({ type: "nope", id: "c" });
  const unknown = await connection.next((record) => record.type === "response" && record.id === "c");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown request type/);

  // Malformed records and requests without an id are ignored, not answered.
  connection.sendRaw("{not json\n");
  connection.send({ type: "get_snapshot" });
  await expectNoRecord(connection, (record) => record.type === "response" && record.id === "");

  // The connection survives and keeps correlating.
  connection.send({ type: "get_snapshot", id: "d" });
  const after = await connection.next((record) => record.type === "response" && record.id === "d");
  assert.equal(after.ok, true);

  await started.cleanup();
});

test("closes a connection whose pending record exceeds 1 MiB", async () => {
  const started = await startBridge();
  const { connection } = started;
  connection.sendRaw(`${"x".repeat(1024 * 1024 + 10)}`);
  await connection.closed;

  // The socket is still healthy for new clients.
  const second = await connect(path.join(started.runtimeDir, "pi-bridge", `${PANE_ID}.sock`));
  const hello = await second.next((record) => record.type === "hello");
  assert.equal(hello.protocol_version, 1);
  await second.close();

  await started.cleanup();
});
