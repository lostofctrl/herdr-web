/**
 * Pi Bridge extension entry point.
 *
 * Activates only inside a Herdr pane, publishes Pi State on a per-pane Unix
 * socket, and answers the version 1 protocol from docs/pi-mode-protocol.md.
 * It is deliberately inert outside a pane: no handlers, no socket, no timers.
 */
import { BridgeSocketInUseError, createBridgeServer, type BridgeServer, type RecordSender } from "./server.ts";
import {
  ASK_USER_ANSWER_EVENT,
  ASK_USER_ANSWER_RESULT_EVENT,
  ASK_USER_BLOCKED_EVENT,
  ASK_USER_PROMPT_EVENT,
  ASK_USER_TOOL_NAME,
  answerEntries,
  notesFromValue,
  questionDialog,
  type AskUserAnswerResultPayload,
  type AskUserBlockedPayload,
  type AskUserPromptPayload,
  type QuestionDialog,
} from "./ask-user.ts";
import { createGenericDialogs } from "./dialogs.ts";
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
  skillsFromCommands,
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

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface ExtensionApiLike {
  on(event: string, handler: (event: any, ctx: any) => unknown): () => void;
  events?: EventBusLike;
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
  let uiPromptActive = false;
  let initialized = false;
  let answerSequence = 0;
  let genericDialogsAvailable = false;
  let wrapWarningShown = false;
  const genericDialogs = createGenericDialogs(
    (dialog) => { server?.broadcast({ type: "dialog_open", dialog }); broadcastState(); },
    (id, resolution) => { broadcastDialogClosed(id, resolution); broadcastState(); },
  );
  const openQuestions = new Map<string, { dialog: QuestionDialog; requestId: string | null; cancel: boolean }>();
  const previewArgs = new Map<string, unknown>();
  const pendingVerdicts = new Map<string, AskUserAnswerResultPayload>();
  const eventDisposers: (() => void)[] = [];

  function busyState(): BridgeBusy {
    if (openQuestions.size > 0 || genericDialogs.snapshot().length > 0 || uiPromptActive) {
      return "dialog";
    }
    return busy;
  }

  function openDialogs() {
    return [...[...openQuestions.values()].map((entry) => entry.dialog), ...genericDialogs.snapshot()];
  }

  function broadcastDialogClosed(id: string, resolution: "answered" | "cancelled" | "terminal" | "timeout"): void {
    server?.broadcast({ type: "dialog_closed", id, resolution });
  }

  function closeQuestion(id: string, resolution: "answered" | "cancelled" | "terminal"): boolean {
    if (!openQuestions.delete(id)) {
      return false;
    }
    broadcastDialogClosed(id, resolution);
    broadcastState();
    return true;
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

  function readCommands(): { name: string; description?: string; source: string }[] | null {
    if (typeof pi.getCommands !== "function") {
      return null;
    }
    try {
      return pi.getCommands() ?? [];
    } catch {
      return null;
    }
  }

  function catalog(): CatalogPayload {
    const commands = readCommands();
    const skills = skillsFromCommands(commands);
    return buildCatalog(commands ?? [], skills.skills, skills.available ? undefined : skills.note);
  }

  function capabilities(): BridgeCapabilities {
    return {
      generic_dialogs: genericDialogsAvailable,
      assistant_message: true,
      list_files: exec !== null,
      skills_catalog: readCommands() !== null,
    };
  }

  function sendSnapshot(send: RecordSender): void {
    send({ type: "hello", protocol_version: PROTOCOL_VERSION, capabilities: capabilities() });
    send({ type: "state", ...statePayload() });
    send({ type: "catalog", ...catalog() });
    if (latestAssistant !== null) {
      send({ type: "assistant_message", text: latestAssistant });
    }
    for (const dialog of openDialogs()) {
      send({ type: "dialog_open", dialog });
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
            dialogs: openDialogs(),
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
        handleDialogAnswer(id, message as { dialog_id?: unknown; value?: unknown; cancel?: unknown }, reply);
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

  function handleDialogAnswer(
    id: string,
    request: { dialog_id?: unknown; value?: unknown; cancel?: unknown },
    reply: RecordSender,
  ): void {
    const dialogId = typeof request.dialog_id === "string" ? request.dialog_id : null;
    if (dialogId && genericDialogs.snapshot().some((dialog) => dialog.id === dialogId)) {
      reply(okResponse(id, { accepted: genericDialogs.answer(dialogId, request.value, request.cancel === true) }));
      return;
    }
    const entry = dialogId ? openQuestions.get(dialogId) : undefined;
    if (!dialogId || !entry) {
      reply(okResponse(id, { accepted: false }));
      return;
    }
    const cancel = request.cancel === true;
    const answers = cancel ? undefined : answerEntries(request.value);
    if (!cancel && !answers) {
      reply(errorResponse(id, "dialog_answer requires answers or cancel"));
      return;
    }
    const events = pi.events;
    if (!events) {
      reply(errorResponse(id, "ask_user_question is not available in this Pi"));
      return;
    }
    const requestId = `question-${++answerSequence}`;
    entry.requestId = requestId;
    entry.cancel = cancel;
    pendingVerdicts.delete(requestId);
    events.emit(ASK_USER_ANSWER_EVENT, {
      toolCallId: dialogId,
      requestId,
      ...(cancel ? { cancel: true } : { answers }),
      ...(!cancel && notesFromValue(request.value) ? { globalNote: notesFromValue(request.value) } : {}),
    });
    const verdict = pendingVerdicts.get(requestId) ?? null;
    pendingVerdicts.delete(requestId);
    if (!verdict) {
      reply(errorResponse(id, "ask_user_question did not answer the request"));
      return;
    }
    reply(okResponse(id, { accepted: verdict.ok === true }));
  }

  function handleQuestionPrompt(payload: AskUserPromptPayload): void {
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    if (!toolCallId) {
      return;
    }
    const dialog = questionDialog(toolCallId, payload, previewArgs.get(toolCallId));
    previewArgs.delete(toolCallId);
    if (!dialog) {
      return;
    }
    openQuestions.set(toolCallId, { dialog, requestId: null, cancel: false });
    server?.broadcast({ type: "dialog_open", dialog });
    broadcastState();
  }

  function handleQuestionBlocked(payload: AskUserBlockedPayload): void {
    if (payload.active !== false || typeof payload.toolCallId !== "string") {
      return;
    }
    closeQuestion(payload.toolCallId, "terminal");
  }

  function handleAnswerResult(payload: AskUserAnswerResultPayload): void {
    if (typeof payload.requestId !== "string") {
      return;
    }
    pendingVerdicts.set(payload.requestId, payload);
    if (payload.ok !== true || typeof payload.toolCallId !== "string") {
      return;
    }
    const entry = openQuestions.get(payload.toolCallId);
    if (!entry || entry.requestId !== payload.requestId) {
      return;
    }
    closeQuestion(payload.toolCallId, entry.cancel ? "cancelled" : "answered");
  }

  function bindEvent(channel: string, handler: (payload: any) => void): void {
    const events = pi.events;
    if (!events) {
      return;
    }
    eventDisposers.push(events.on(channel, handler));
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
    genericDialogs.stop();
    genericDialogsAvailable = ctx.mode === "tui" && ctx.hasUI === true && genericDialogs.install(ctx.ui);
    if (!genericDialogsAvailable && !wrapWarningShown) {
      wrapWarningShown = true;
      const warning = "Pi Bridge could not wrap shared ctx.ui dialogs; generic Native Cards are disabled. Use the terminal dialog or Key Bar.";
      ctx.ui?.notify?.(warning, "warning");
      log(warning);
    }
    busy = "idle";
    uiPromptActive = false;
    for (const id of openQuestions.keys()) {
      broadcastDialogClosed(id, "terminal");
    }
    openQuestions.clear();
    previewArgs.clear();
    pendingVerdicts.clear();
    currentModel = ctx.model ?? null;
    latestAssistant = latestAssistantFromEntries(ctx.sessionManager?.getEntries?.() ?? []);
    await ensureServer();
    // A session replacement keeps the same pane socket; refresh connected clients.
    if (server?.isRunning()) {
      server.broadcast({ type: "hello", protocol_version: PROTOCOL_VERSION, capabilities: capabilities() });
      broadcastState();
      server.broadcast({ type: "catalog", ...catalog() });
    }
  });

  bind("session_shutdown", async () => {
    genericDialogs.stop();
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
    uiPromptActive = true;
    broadcastState();
  });

  bind("ui_prompt_end", () => {
    uiPromptActive = false;
    broadcastState();
  });

  bind("tool_execution_start", (event) => {
    if (event?.toolName !== ASK_USER_TOOL_NAME || typeof event.toolCallId !== "string") {
      return;
    }
    previewArgs.set(event.toolCallId, event.args);
    while (previewArgs.size > 32) {
      const oldest = previewArgs.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      previewArgs.delete(oldest);
    }
  });

  bindEvent(ASK_USER_PROMPT_EVENT, (payload) => {
    handleQuestionPrompt((payload ?? {}) as AskUserPromptPayload);
  });
  bindEvent(ASK_USER_BLOCKED_EVENT, (payload) => {
    handleQuestionBlocked((payload ?? {}) as AskUserBlockedPayload);
  });
  bindEvent(ASK_USER_ANSWER_RESULT_EVENT, (payload) => {
    handleAnswerResult((payload ?? {}) as AskUserAnswerResultPayload);
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
      genericDialogs.stop();
      for (const dispose of eventDisposers.splice(0)) {
        dispose();
      }
      await stopServer();
    },
  };
}

export default function piBridgeExtension(pi: ExtensionApiLike): PiBridge {
  return createPiBridge(pi);
}

export { PROTOCOL_VERSION, THINKING_LEVELS };
