# Pi Bridge protocol (version 1)

The Pi Bridge is a Pi extension that runs inside a Pi Pane and listens on a per-pane Unix
socket. The herdr-web Rust bridge relays this protocol verbatim over an authenticated
WebSocket, so the browser speaks it directly. It is transport-agnostic JSONL: one UTF-8
JSON object per line, no framing beyond `\n`.

ADR [0001](adr/0001-pi-mode-terminal-mirror-plus-extension-bridge.md) explains why this
bridge exists. The terms below are defined in [GLOSSARY.md](../GLOSSARY.md).

## Socket

```text
$XDG_RUNTIME_DIR/pi-bridge/<HERDR_PANE_ID>.sock
```

When `XDG_RUNTIME_DIR` is unset, fall back to `${TMPDIR:-/tmp}/pi-bridge-<uid>/`. The
extension is inert unless `HERDR_PANE_ID` is set. The socket is created on `session_start`,
replaced on restart, and unlinked on `session_shutdown`. It must be readable only by the
current user (`0700` directory, `0600` socket where supported).

A record is capped at 1 MiB in both directions. Larger records are a protocol error.

## Messages: Pi Bridge to client

Every message is an object with a `type`.

| `type` | Fields |
| --- | --- |
| `hello` | `protocol_version: 1`, `capabilities` |
| `state` | `busy`, `model`, `thinking_level`, `models`, `thinking_levels`, `cwd` |
| `catalog` | `commands`, `skills` |
| `dialog_open` | `dialog` |
| `dialog_closed` | `id`, `resolution` |
| `assistant_message` | `text` |
| `response` | `id`, `ok`, and `result` or `error` |

`capabilities` is an object of booleans: `generic_dialogs`, `assistant_message`,
`list_files`, `skills_catalog`. A client hides a feature whose capability is `false` or
absent. `generic_dialogs` covers wrapped `ctx.ui` dialogs only (ADR 0002); a
`dialog_open` with `kind: "question"` is delivered whenever the installed
`ask_user_question` extension emits its prompt, regardless of that capability.

`state.busy` is one of `idle`, `busy`, `dialog`. `state.model` is
`{provider, id}` or `null`; `models` is an array of `{provider, id, label}`. `thinking_level`
is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `thinking_levels`
lists the supported values. `cwd` is Pi's working directory.

`catalog.commands` and `catalog.skills` are arrays of
`{name, description, source}`. Skills come from `pi.getCommands()` entries with
`source: "skill"`; the bridge strips the `skill:` trigger prefix, so `skill:deploy`
becomes `{name: "deploy", source: "skill"}` and remains `/skill:deploy` when inserted.
`skills_note` is present only when Pi does not expose `getCommands()`; clients then show
commands only and `skills_catalog` is `false`. A host with `getCommands()` advertises
`skills_catalog: true` even when the skills list is empty.

`dialog` is one of:

```json
{"id":"d1","kind":"question","timeout_ms":null,"questions":[{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"Stack","description":"One column","preview":"<optional markdown>"}]}]}
{"id":"d1","kind":"select","title":"Pick","message":"","options":[{"label":"a","description":"","preview":""}],"timeout_ms":null}
{"id":"d1","kind":"confirm","title":"Continue?","message":"...","timeout_ms":null}
{"id":"d1","kind":"input","title":"Name","placeholder":"...","timeout_ms":null}
```

`questions` for `ask_user_question` uses Pi's question shape and carries every option,
description, preview and multi-select flag the tool provides. `preview` is `""` when the
option has none. `timeout_ms` is the Pi-owned timeout when the dialog has one; clients
render a countdown but never enforce it.

`dialog_closed.resolution` is one of `answered`, `cancelled`, `timeout`, `terminal`.
`answered` and `cancelled` mean the Pi Bridge relayed the winning answer or decline;
`terminal` means the questionnaire settled inside Pi's own dialog (an answer or Esc).
`timeout` is reserved for Pi-owned generic dialogs.

## Messages: client to Pi Bridge

Every request carries a client-chosen `id` (string), echoed on its `response`.

| `type` | Fields |
| --- | --- |
| `get_snapshot` | `id` |
| `dialog_answer` | `id`, `dialog_id`, and either `value` or `cancel: true` |
| `set_model` | `id`, `provider`, `model` |
| `set_thinking_level` | `id`, `level` |
| `list_files` | `id`, `query`, `limit` |

`get_snapshot` responds with `{state, catalog, dialogs, assistant_message}` in `result`;
`dialogs` lists every open question or generic dialog so a reconnecting client can render
it again. Generic dialogs report `timeout_ms` as the time remaining when the snapshot is
sent, and `null` when Pi set no timeout.
`dialog_answer` responds with `{accepted}`; answering an already settled dialog is
`ok: true` with `accepted: false` because another surface won the race. For a question
dialog, `value` is `{answers:[{questionIndex, optionIndexes?, text?}], globalNote?}` with
every question answered exactly once, or `cancel: true` to decline like Esc. For a generic
dialog, `value` is the selected option label for `select`, a boolean for `confirm`, and
the entered string for `input`; `cancel: true` settles it as `undefined`/`false` like Esc. `list_files`
answers from tracked files in Pi's `cwd`, filters by `query`, and caps at `limit`, which the
client limits to 200 (default 50). Its `result` is `{files: [{path}]}`.

`set_model` and `set_thinking_level` change Pi and cause a fresh `state` broadcast.

## `ask_user_question` relay

The Pi Bridge listens on Pi's shared extension event bus (`pi.events`) for the
`@juicesharp/rpiv-ask-user-question` contract:

| rpiv channel | Direction | Bridge use |
| --- | --- | --- |
| `rpiv:ask-user:prompt` | subscribe | build `dialog_open` (`kind: "question"`), `id` = `toolCallId` |
| `rpiv:ask-user:blocked` | subscribe | `{active:false}` for that `toolCallId` emits `dialog_closed` with `terminal` |
| `rpiv:ask-user:answer` | emit | relay a `dialog_answer` as `{toolCallId, requestId, answers}` or `{cancel:true}` |
| `rpiv:ask-user:answer-result` | subscribe | correlate the verdict by `requestId`; `ok:false` means the terminal won and the request answers `accepted:false` |

The prompt payload deliberately ships only `hasPreview` and not the preview text
(`@juicesharp/rpiv-ask-user-question/events.ts`). The bridge fills `preview` from the
matching `ask_user_question` tool arguments captured on Pi's `tool_execution_start`
event (`dist/core/extensions/types.d.ts:853-859`). Answer validation stays with the
extension: it accepts only a complete, in-range answer set, so a malformed
`dialog_answer` gets `accepted:false` and the card stays open.

## Rules both sides rely on

- Dialog answers settle first-answer-wins across the terminal and every connected client;
  every client receives `dialog_closed` however the dialog settles.
- The client resyncs with `get_snapshot` after the relay reconnects or the page resumes.
- Bridge Offline is a relay state, not a protocol record: a missing socket, a refused
  connection or a closed relay means no Pi Bridge is reachable.
- Unknown `type` values and malformed records are answered with
  `{ok: false, error: "<reason>"}` when an `id` is present, and ignored otherwise.

## Relay over the herdr-web bridge

The browser never touches the Unix socket. It opens one authenticated WebSocket per Pi
Pane:

```text
GET /ws/pi?pane_id=<pane_id>
```

`pane_id` must be in the bridge's current pane list; anything else is rejected before the
socket is opened. The relay connects to
`$XDG_RUNTIME_DIR/pi-bridge/<pane_id>.sock` (or the same `${TMPDIR:-/tmp}` fallback) and
forwards each JSONL record in both directions as one WebSocket text frame without the
trailing newline. It never inspects or rewrites a record beyond the 1 MiB cap.

Relay-level failures are WebSocket close codes, not protocol records:

| Code | Reason | Meaning |
| --- | --- | --- |
| 4500 | `bridge_offline` | socket missing or refused; the client shows Bridge Offline |
| 4501 | `unknown_pane` | pane is not in this bridge's pane list |
| 4502 | `record_too_large` | a record exceeded 1 MiB |
| 1011 | relay error | unexpected I/O failure after connect |

The browser reconnects with backoff, sends `get_snapshot` after every successful
reconnect and on app resume, and treats any close as Bridge Offline until the next
successful `hello`. The terminal WebSocket on the same pane is unaffected.
