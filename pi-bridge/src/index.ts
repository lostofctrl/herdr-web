/**
 * Pi Bridge extension entry point.
 *
 * Activates only inside a Herdr pane, publishes Pi State on a per-pane Unix
 * socket, and answers the version 1 protocol from docs/pi-mode-protocol.md.
 * It is deliberately inert outside a pane: no handlers, no socket, no timers.
 */
import { BridgeSocketInUseError, createBridgeServer, type BridgeServer, type RecordSender } from "./server.ts";
import { listTrackedFiles, type ExecLike } from "./files.ts";
import { resolveSocketPath } from "./pane.ts";
import {
  MAX_RECORD_BYTES,
  PROTOCOL_VERSION,
  THINKING_LEVELS,
  clampFileLimit,
  errorResponse,
  okResponse,
  type BridgeCapabilities,
  type BridgeBusy,
  type CatalogPayload,
  type PiStatePayload,
} from "./protocol.ts";
import {
  availableModels,
  buildCatalog,
  extractAssistantText,
  latestAssistantFromEntries,
  modelRef,
  readSkills,
  thinkingLevelsFor,
  type ContextLike,
  type ModelLike,
} from "./state.ts";

export interface PiBridgeOptions {
  env?: Record<string, string | undefined>;
  /** Override the resolved socket path; `null` disables the bridge. */
  socketPath?: string | null;
  exec?: ExecLike;
  log?: (message: string) => void;
}

export interface PiBridge {
  readonly socketPath: string | null;
  isRunning(): boolean;
  stop(): Promise<void>;
}

interface ExtensionApiLike {
  on(event: string, handler: (event: any, ctx: any) => unknown): () => void;
  getCommands?: () => { name: string; description?: string; source: string }[];
  getThinkingLevel?: () => string;
  setModel?: (model: ModelLike) => Promise<boolean> | boolean;
  setThinkingLevel?: (level: string) => void;
  exec?: ExecLike;
}

export function createPiBridge(pi: ExtensionApiLike, options: PiBridgeOptions = {}): PiBridge {
  const env = options.env ?? process.env;
  const socketPath =
    options.socketPath === undefined ? resolveSocketPath(env) : options.socketPath;
  const log = options.log ?? (() => {});
  if (!socketPath) {
    return { socketPath: null, isRunning: () => false, stop: async () => {} };
  }

  const exec: ExecLike | null = options.exec ?? pi.exec ?? null;
  let context: ContextLike | null = null;
  let server: BridgeServer | null = null;
  let latestAssistant: string | null = null;
  let currentModel: ModelLike | null = null;
  let busy: "idle" | "busy" = "idle";
  let dialogOpen = false;
  let initialized = false;

  function busyState(): BridgeBusy {
    if (dialogOpen) {
      return "dialog";
    }
    return busy;
  }

  function statePayload(): PiStatePayload {
    return {
      busy: busyState(),
      model: modelRef(currentModel),
      thinking_level: readThinkingLevel(),
      models: availableModels(context),
      thinking_levels: thinkingLevelsFor(currentModel),
      cwd: context?.cwd ?? "",
    };
  }

  function readThinkingLevel(): string | null {
    if (typeof pi.getThinkingLevel === "function") {
      try {
        return pi.getThinkingLevel();
      } catch {
        // Fall through to the context snapshot.
      }
    }
    return context?.thinkingLevel ?? null;
  }

  function catalog(): CatalogPayload {
    const skills = readSkills(context);
    const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
    return buildCatalog(commands, skills.skills, skills.available ? undefined : skills.note);
  }

  function capabilities(): BridgeCapabilities {
    return {
      generic_dialogs: false,
      assistant_message: true,
      list_files: exec !== null,
      skills_catalog: readSkills(context).available,
    };
  }

  function sendSnapshot(send: RecordSender): void {
    send({ type: "hello", protocol_version: PROTOCOL_VERSION, capabilities: capabilities() });
    send({ type: "state", ...statePayload() });
    send({ type: "catalog", ...catalog() });
    if (latestAssistant !== null) {
      send({ type: "assistant_message", text: latestAssistant });
    }
  }

  function broadcastState(): void {
    server?.broadcast({ type: "state", ...statePayload() });
  }

  async function handleLine(line: string, reply: RecordSender): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      log("ignoring a request over the 1 MiB protocol cap");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Malformed records without an id are ignored per the protocol.
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return;
    }
    const request = message as { type?: unknown; id?: unknown };
    if (typeof request.id !== "string" || request.id.length === 0) {
      // Without an id there is nothing to correlate a response with.
      return;
    }
    const id = request.id;
    switch (request.type) {
      case "get_snapshot": {
        reply(
          okResponse(id, {
            state: statePayload(),
            catalog: catalog(),
            dialogs: [],
            assistant_message: latestAssistant,
          }),
        );
        return;
      }
      case "set_model": {
        await handleSetModel(id, message as { provider?: unknown; model?: unknown }, reply);
        return;
      }
      case "set_thinking_level": {
        handleSetThinkingLevel(id, message as { level?: unknown }, reply);
        return;
      }
      case "list_files": {
        await handleListFiles(id, message as { query?: unknown; limit?: unknown }, reply);
        return;
      }
      case "dialog_answer": {
        // Native Cards are not installed in this version (generic_dialogs:false).
        reply(okResponse(id, { accepted: false }));
        return;
      }
      default: {
        reply(errorResponse(id, `unknown request type: ${String(request.type)}`));
      }
    }
  }

  async function handleSetModel(
    id: string,
    request: { provider?: unknown; model?: unknown },
    reply: RecordSender,
  ): Promise<void> {
    const provider = typeof request.provider === "string" ? request.provider : null;
    const modelId = typeof request.model === "string" ? request.model : null;
    if (!provider || !modelId) {
      reply(errorResponse(id, "set_model requires provider and model"));
      return;
    }
    const model = context?.modelRegistry?.find?.(provider, modelId);
    if (!model) {
      reply(errorResponse(id, `unknown model: ${provider}/${modelId}`));
      return;
    }
    if (typeof pi.setModel !== "function") {
      reply(errorResponse(id, "this Pi does not support set_model"));
      return;
    }
    let changed: boolean;
    try {
      changed = await pi.setModel(model);
    } catch (error) {
      reply(errorResponse(id, `model switch failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (changed === false) {
      reply(errorResponse(id, `Pi refused to switch to ${provider}/${modelId}`));
      return;
    }
    currentModel = model;
    reply(okResponse(id, { state: statePayload() }));
    broadcastState();
  }

  function handleSetThinkingLevel(
    id: string,
    request: { level?: unknown },
    reply: RecordSender,
  ): void {
    const level = request.level;
    if (typeof level !== "string" || !THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
      reply(errorResponse(id, `invalid thinking level: ${String(level)}`));
      return;
    }
    if (typeof pi.setThinkingLevel !== "function") {
      reply(errorResponse(id, "this Pi does not support set_thinking_level"));
      return;
    }
    try {
      pi.setThinkingLevel(level);
    } catch (error) {
      reply(errorResponse(id, `thinking level change failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    reply(okResponse(id, { state: statePayload() }));
    broadcastState();
  }

  async function handleListFiles(
    id: string,
    request: { query?: unknown; limit?: unknown },
    reply: RecordSender,
  ): Promise<void> {
    if (!exec || !context) {
      reply(errorResponse(id, "file listing is unavailable"));
      return;
    }
    try {
      const files = await listTrackedFiles(exec, {
        cwd: context.cwd,
        query: request.query,
        limit: clampFileLimit(request.limit),
      });
      reply(okResponse(id, { files: files.map((file) => ({ path: file })) }));
    } catch (error) {
      reply(errorResponse(id, `file listing failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  function bind(event: string, handler: (event: any, ctx: ContextLike) => unknown): void {
    pi.on(event, async (payload, ctx) => {
      context = ctx;
      return handler(payload, ctx);
    });
  }

  async function ensureServer(): Promise<void> {
    if (server?.isRunning()) {
      return;
    }
    const created = createBridgeServer({
      socketPath,
      log,
      onLine: handleLine,
      onClientConnect: sendSnapshot,
    });
    try {
      await created.start();
      server = created;
      initialized = true;
    } catch (error) {
      if (error instanceof BridgeSocketInUseError) {
        log(error.message);
        return;
      }
      log(`failed to start the pi bridge socket: ${String(error)}`);
    }
  }

  async function stopServer(): Promise<void> {
    const current = server;
    server = null;
    if (current) {
      await current.stop();
    }
    initialized = false;
  }

  bind("session_start", async (_event, ctx) => {
    busy = "idle";
    dialogOpen = false;
    currentModel = ctx.model ?? null;
    latestAssistant = latestAssistantFromEntries(ctx.sessionManager?.getEntries?.() ?? []);
    await ensureServer();
    // A session replacement keeps the same pane socket; refresh connected clients.
    if (server?.isRunning()) {
      broadcastState();
      server.broadcast({ type: "catalog", ...catalog() });
    }
  });

  bind("session_shutdown", async () => {
    await stopServer();
  });

  bind("agent_start", () => {
    busy = "busy";
    broadcastState();
  });

  bind("agent_end", () => {
    busy = "idle";
    broadcastState();
  });

  bind("ui_prompt_start", () => {
    dialogOpen = true;
    broadcastState();
  });

  bind("ui_prompt_end", () => {
    dialogOpen = false;
    broadcastState();
  });

  bind("model_select", (event) => {
    if (event?.model) {
      currentModel = event.model;
    }
    broadcastState();
  });

  bind("thinking_level_select", () => {
    broadcastState();
  });

  bind("message_end", (event) => {
    if (event?.message?.role !== "assistant") {
      return;
    }
    latestAssistant = extractAssistantText(event.message);
    server?.broadcast({ type: "assistant_message", text: latestAssistant });
  });

  return {
    socketPath,
    isRunning: () => Boolean(initialized && server?.isRunning()),
    stop: async () => {
      await stopServer();
    },
  };
}

export default function piBridgeExtension(pi: ExtensionApiLike): PiBridge {
  return createPiBridge(pi);
}

export { PROTOCOL_VERSION, THINKING_LEVELS };
