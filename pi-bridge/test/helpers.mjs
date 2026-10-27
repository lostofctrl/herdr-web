import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

export function makeModel(id, provider = "anthropic", label = id) {
  return {
    id,
    name: label,
    provider,
    api: "anthropic-messages",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  };
}

export const DEFAULT_MODELS = [makeModel("claude-sonnet-4"), makeModel("claude-opus-4")];

export const DEFAULT_COMMANDS = [
  { name: "compact", description: "Compact the session", source: "prompt" },
  { name: "deploy", description: "Deploy the app", source: "extension" },
  { name: "brainstorm", description: "Brainstorm ideas", source: "skill" },
];

const DEFAULT_SKILLS = [
  {
    name: "brainstorm",
    description: "Brainstorm ideas",
    filePath: "/skills/brainstorm/SKILL.md",
    baseDir: "/skills/brainstorm",
    sourceInfo: {},
    disableModelInvocation: false,
  },
];

/**
 * Fake of the real Pi extension API/context (src/core/extensions/types.d.ts).
 * Only the surfaces the bridge is allowed to touch are implemented.
 * `options.skills = null` hides Pi's internal resourceLoader to test fallback.
 */
export function createFakeExtension(options = {}) {
  const models = options.models ?? DEFAULT_MODELS;
  const commands = options.commands ?? DEFAULT_COMMANDS;
  const entries = options.entries ?? [];
  const cwd = options.cwd ?? "/work/repo";
  const handlers = new Map();
  const eventHandlers = new Map();
  const registered = [];
  const calls = { setModel: [], setThinkingLevel: [], exec: [] };

  let currentModel = options.model ?? models[0];
  let currentThinking = options.thinkingLevel ?? "medium";

  const sessionManager = {
    getEntries: () => entries,
    getCwd: () => cwd,
  };
  if (options.skills !== null) {
    sessionManager.resourceLoader = {
      getSkills: () => ({ skills: options.skills ?? DEFAULT_SKILLS, diagnostics: [] }),
    };
  }

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return currentThinking;
    },
    scopedModels: options.scopedModels ?? models.map((model) => ({ model })),
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
    },
    sessionManager,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
    },
    isIdle: () => true,
  };

  const pi = {
    on(event, handler) {
      registered.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    getCommands: () => commands,
    getThinkingLevel: () => currentThinking,
    async setModel(model) {
      calls.setModel.push(model);
      currentModel = model;
      return true;
    },
    setThinkingLevel(level) {
      calls.setThinkingLevel.push(level);
      currentThinking = level;
    },
    events: {
      emit(channel, data) {
        for (const handler of [...(eventHandlers.get(channel) ?? [])]) {
          handler(data);
        }
      },
      on(channel, handler) {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
        return () => {
          const current = eventHandlers.get(channel) ?? [];
          const index = current.indexOf(handler);
          if (index >= 0) {
            current.splice(index, 1);
          }
        };
      },
    },
    async exec(command, args, execOptions) {
      calls.exec.push({ command, args, options: execOptions });
      if (options.execError) {
        return { stdout: "", stderr: options.execError, code: 1, killed: false };
      }
      return options.execResult ?? { stdout: "", stderr: "", code: 0, killed: false };
    },
  };

  async function emit(event, payload = { type: event }) {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  return { pi, ctx, calls, registered, emit };
}

/** Minimal JSONL client for the per-pane Unix socket. */
export async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  socket.setEncoding("utf8");

  let buffer = "";
  const records = [];
  const waiters = [];
  let disconnected = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  socket.on("close", () => {
    disconnected = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error("socket closed before a matching record arrived"));
    }
    resolveClosed();
  });

  socket.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const record = JSON.parse(line);
        records.push(record);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(record)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(record);
          }
        }
      }
      index = buffer.indexOf("\n");
    }
  });

  function next(predicate = () => true, timeoutMs = 3000) {
    const foundIndex = records.findIndex(predicate);
    if (foundIndex >= 0) {
      return Promise.resolve(records.splice(foundIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for record; buffered=${JSON.stringify(records)}`)),
        timeoutMs,
      );
      waiters.push({
        predicate,
        resolve: (record) => {
          clearTimeout(timer);
          resolve(record);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  function send(record) {
    socket.write(`${JSON.stringify(record)}\n`);
  }

  function sendRaw(text) {
    socket.write(text);
  }

  async function close() {
    socket.destroy();
    await closed;
  }

  return { socket, next, send, sendRaw, close, closed, isDisconnected: () => disconnected };
}

export async function expectNoRecord(connection, predicate, timeoutMs = 200) {
  await assert.rejects(connection.next(predicate, timeoutMs), /timed out/);
}
