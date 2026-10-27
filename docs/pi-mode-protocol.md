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
absent.

`state.busy` is one of `idle`, `busy`, `dialog`. `state.model` is
`{provider, id}` or `null`; `models` is an array of `{provider, id, label}`. `thinking_level`
is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `thinking_levels`
lists the supported values. `cwd` is Pi's working directory.

`catalog.commands` and `catalog.skills` are arrays of
`{name, description, source}`. `skills_note` is present when the skill catalog could not be
read from a supported Pi API; clients then show commands only.

`dialog` is one of:

```json
{"id":"d1","kind":"question","questions":[...],"timeout_ms":null}
{"id":"d1","kind":"select","title":"Pick","message":"","options":[{"label":"a","description":"","preview":""}],"timeout_ms":null}
{"id":"d1","kind":"confirm","title":"Continue?","message":"...","timeout_ms":null}
{"id":"d1","kind":"input","title":"Name","placeholder":"...","timeout_ms":null}
```

`questions` for `ask_user_question` uses Pi's question shape and carries every option,
description, preview and multi-select flag the tool provides. `timeout_ms` is the Pi-owned
timeout when the dialog has one; clients render a countdown but never enforce it.

`dialog_closed.resolution` is one of `answered`, `cancelled`, `timeout`, `terminal`.

## Messages: client to Pi Bridge

Every request carries a client-chosen `id` (string), echoed on its `response`.

| `type` | Fields |
| --- | --- |
| `get_snapshot` | `id` |
| `dialog_answer` | `id`, `dialog_id`, and either `value` or `cancel: true` |
| `set_model` | `id`, `provider`, `model` |
| `set_thinking_level` | `id`, `level` |
| `list_files` | `id`, `query`, `limit` |

`get_snapshot` responds with `{state, catalog, dialogs, assistant_message}` in `result`.
`dialog_answer` responds with `{accepted}`; answering an already settled dialog is
`ok: true` with `accepted: false` because another surface won the race. `list_files`
answers from tracked files in Pi's `cwd`, filters by `query`, and caps at `limit`, which the
client limits to 200 (default 50). Its `result` is `{files: [{path}]}`.

`set_model` and `set_thinking_level` change Pi and cause a fresh `state` broadcast.

## Rules both sides rely on

- Dialog answers settle first-answer-wins across the terminal and every connected client;
  every client receives `dialog_closed` however the dialog settles.
- The client resyncs with `get_snapshot` after the relay reconnects or the page resumes.
- Bridge Offline is a relay state, not a protocol record: a missing socket, a refused
  connection or a closed relay means no Pi Bridge is reachable.
- Unknown `type` values and malformed records are answered with
  `{ok: false, error: "<reason>"}` when an `id` is present, and ignored otherwise.
