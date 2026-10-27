# Pi Bridge

The Pi Bridge is a Pi extension that runs inside a Pi Pane and publishes
[Pi State](../../GLOSSARY.md) plus a small action set to herdr-web over a per-pane
Unix socket. It is inert outside a Herdr pane, so installing it does not change
normal Pi sessions.

The wire contract is [`docs/pi-mode-protocol.md`](../../docs/pi-mode-protocol.md)
(version 1). This package is self-contained: it has no npm dependencies and does
not import `lostofctrl/pi-ext` or any unpublished package.

## Activation and socket

- Activates only when `HERDR_PANE_ID` is set (verified with Herdr 0.9.3).
- Listens on `$XDG_RUNTIME_DIR/pi-bridge/<HERDR_PANE_ID>.sock`, or
  `${TMPDIR:-/tmp}/pi-bridge-<uid>/<HERDR_PANE_ID>.sock` when `XDG_RUNTIME_DIR`
  is unset. A pane id containing `/`, `\` or `..` is refused.
- Starts on `session_start`, replaces a stale socket left by a crashed Pi,
  refuses to steal a socket from a live bridge, and unlinks it on
  `session_shutdown`.
- Socket directory is `0700`, socket `0600` where the platform supports it.
  Records over 1 MiB are a protocol error: inbound oversized lines close the
  connection and outbound oversized records are dropped.

## Protocol

Implemented as `docs/pi-mode-protocol.md` version 1:

- Bridge → client: `hello`, `state`, `catalog`, `dialog_open`, `dialog_closed`,
  `assistant_message`, `response`.
- Client → bridge: `get_snapshot`, `set_model`, `set_thinking_level`,
  `list_files`, `dialog_answer`.
- `hello.capabilities` is currently
  `{generic_dialogs: false, assistant_message: true, list_files: true, skills_catalog}`.
  `generic_dialogs` covers wrapped `ctx.ui` dialogs (follow-up ticket); question
  dialogs are relayed from `ask_user_question` independently.
- `ask_user_question` questionnaires are relayed through Pi's extension event bus:
  `rpiv:ask-user:prompt` becomes `dialog_open` with the full question set (options,
  descriptions, previews, multi-select), `dialog_answer` becomes
  `rpiv:ask-user:answer`, and `rpiv:ask-user:blocked {active:false}` or an accepted
  answer emits `dialog_closed`. First answer wins across phone, desktop and terminal.
- `state.busy` is `idle`, `busy` or `dialog`. It follows `agent_start` /
  `agent_end` and `ui_prompt_start` / `ui_prompt_end`.
- `get_snapshot.dialogs` lists open question dialogs.

## Pi API surface

Only declared Pi 1.4.0 surfaces are used. Paths are relative to
`@earendil-works/pi-coding-agent/dist/`.

| Surface | Used for | Declaration |
| --- | --- | --- |
| `ExtensionContext.cwd` | `state.cwd`, `list_files` cwd | `core/extensions/types.d.ts:221` |
| `ctx.sessionManager` / `getEntries()` | latest assistant message on session start | `types.d.ts:223`, `core/session-manager.d.ts:334` |
| `ctx.model` | `state.model` | `types.d.ts:227` |
| `ctx.modelRegistry.find()` / `getAvailable()` | `set_model`, `state.models` | `types.d.ts:225`, `core/model-registry.d.ts:28-29` |
| `ctx.scopedModels` | scoped model list | `types.d.ts:232` |
| `ctx.thinkingLevel` | thinking-level fallback | `types.d.ts:234` |
| `pi.on("session_start" / "session_shutdown")` | socket lifecycle | `types.d.ts:1189`, `types.d.ts:1196` |
| `pi.on("agent_start" / "agent_end")` | `state.busy` | `types.d.ts:1208-1209` |
| `pi.on("ui_prompt_start" / "ui_prompt_end")` | `state.busy = "dialog"` | `types.d.ts:1212-1213`, events at `types.d.ts:808-820` |
| `pi.on("model_select" / "thinking_level_select")` | fresh `state` broadcast | `types.d.ts:1222-1223` |
| `pi.on("message_end")` | `assistant_message` | `types.d.ts:1218`, event at `types.d.ts:848` |
| `pi.on("tool_execution_start")` | full `ask_user_question` previews | `types.d.ts:1219`, event at `types.d.ts:853-859` |
| `pi.events` (EventBus) | rpiv prompt/blocked/answer-result, answer | `types.d.ts:1406`, `core/event-bus.d.ts:1` |
| `pi.getCommands()` | `catalog.commands` | `types.d.ts:1293`, `core/slash-commands.d.ts:3-9` |
| `pi.setModel()` | `set_model` | `types.d.ts:1298` |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel()` | `state.thinking_level`, `set_thinking_level` | `types.d.ts:1300`, `types.d.ts:1305` |
| `pi.exec()` | `git ls-files -z` for `list_files` | `types.d.ts:1280` |
| `ThinkingLevel` union | validation, `thinking_levels` | `@earendil-works/pi-agent-core/dist/types.d.ts:300` |
| `Model` (`id`, `name`, `provider`, `thinkingLevelMap`) | state payloads | `@earendil-works/pi-ai/dist/types.d.ts:630-655` |

### Known API risk: skills catalog

Pi 1.4.0 has no public skills API. The bridge reads the internal
`sessionManager.resourceLoader.getSkills()` (declared only on
`core/resource-loader.d.ts:34`, not on `ReadonlySessionManager`) inside a
`try/catch`. If it is unavailable or throws, `catalog.skills` is `[]`,
`catalog.skills_note` explains why, and `capabilities.skills_catalog` is `false`.
A Pi upgrade may move or remove that internal surface; the fallback keeps the
protocol valid.

## Tests

Seam 1: a fake extension API/context drives the real extension, and tests speak
to a real Unix socket in a temporary directory.

```sh
npm test --prefix pi-bridge
```

Coverage: inert outside Herdr, contract socket path and temp fallback, hello and
snapshot, state transitions, latest assistant message (and ignoring user
messages), socket cleanup/replacement/live-conflict, `set_model`,
`set_thinking_level`, tracked-file filtering and the 200-file cap, response
correlation, ignored malformed records, and the 1 MiB cap.
