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

The path rule is implemented twice on purpose — `pi-bridge/src/pane.ts` for the writer and
`pi_bridge_socket_dir`/`pi_socket_path` in `bridge/src/web_bridge.rs` for the reader — because
the writer is a Pi extension and the reader is the Rust bridge. They must agree: change them
together, and keep `pi-bridge/test/lifecycle.test.mjs` and the relay tests
in `bridge/src/web_bridge.rs` in step.

The socket is the trust boundary. Any process running as the same user can bind
`pi-bridge/<pane_id>.sock` and be relayed to the browser, so this protocol assumes the local
user account is trusted and the runtime directory is not shared. The bridge adds no further
authentication on the Unix side; it only restricts HTTP/WS access to allowed origins and known
pane ids.

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


## Read-only conversation context (conversation schema 1)

This additive feature is independent of protocol v1 snapshots and the legacy Reader Sheet.
`hello.capabilities.conversation_snapshot` is true only when the live session manager exposes
`getBranch()`, `getSessionId()` and `getLeafId()`. `hello.conversation_epoch` identifies the
extension runtime. Missing capability/epoch means unavailable context, not disabled terminal
or Composer controls. Old clients ignore these additive records; new clients do not ask old
bridges for conversation. Legacy `state`, `catalog`, dialogs, `assistant_message`, and
`get_snapshot` retain their existing contents and limits.

Clients send `get_conversation` with `id` and `schema_version: 1`. The bridge sends a separate
`conversation_update` carrying `request_id: id`, then an ordinary successful `response` with
an empty result. Unsupported request schemas receive an error response. Lifecycle updates
use the same record without `request_id`; they never change a draft or send input.

Every conversation update contains:

- `type: "conversation_update"`, `schema_version: 1`;
- `epoch`, `session_id`, `leaf_id`, `selection_generation`, `revision`;
- `availability: "ready" | "unavailable"`, `reason: string | null`, `exchanges`.

`epoch` is a fresh runtime UUID announced by hello. Session identity and selected leaf come
from the live manager, never disk, terminal output, browser history, or the all-entry list.
`leaf_id` may be null for an empty branch. `selection_generation` increases for session
start and before switch/fork/tree/compaction, including navigating away and back to the
same leaf. `revision` increases monotonically across every update/request in that runtime.
The selected leaf can advance within a generation as messages are recorded. A different
session requires a newer generation. Null identities on an unavailable record make no
identity claim (for example, essential metadata too large); they are never truncated IDs.

`exchanges` contains zero, one, or two distinct first/latest user-led exchanges in the
selected root-to-leaf ancestry. Each has `user`, `assistant`, `status`, `user_truncated`,
and `assistant_truncated`. Public text blocks (and string user content) only are included;
assistant messages are joined until the next user. Empty/tool-only updates do not erase
prior public text or an interrupted status. Thinking, tool calls/results, images, custom
messages, compaction and branch summaries are excluded. An unanswered user stays separate
from the prior answer. Status is `pending`, `running`, `complete`, `aborted`, or `error`;
completed interrupted text remains readable. A successful completed assistant message with no
public text leaves an unanswered current user `pending` (or `running` while the run is active),
not falsely answered. An empty completion after eligible public text preserves that text and its
status. Streaming deltas are not published.

Before selection/authority changes, updates immediately become unavailable and empty.
Session start/reload/new/resume/fork, tree navigation, compaction success/failure, run-status
changes, and recorded message completion refresh the context. Pi awaits extension
`message_end` handlers before persisting the message, so that refresh runs on a later
macrotask, pinned to the runtime/context and selection generation. Reconnect and page/native
resume request fresh authority rather than trusting cached text. An explicit conversation
request also revalidates the currently selected live ancestry after a cancelled before-hook
operation (Pi does not emit a matching completion event for every cancelled operation).
Clients clear on socket,
pane, bridge, capability or epoch loss and ignore old socket/request/generation/revision/
session records. Unsupported, malformed or oversized conversation records clear context
without disabling other Pi controls. Text is untrusted and rendered as React text, not HTML.

### Conversation byte budgets

Conversation records alone have a **64 KiB actual UTF-8 encoded JSON record cap**, including
all envelope fields, JSON escaping and optional request ID. Each text field has a **16 KiB
UTF-8 cap**. Empty-text identity/status/structure metadata may occupy at most **8 KiB**;
metadata that cannot fit produces `unavailable` / `metadata_too_large` with no exchanges,
never shortened identities. Excessively large request IDs may be omitted from that
unavailable update. The ordinary response still uses the request ID under the legacy cap.

The remaining encoded-record budget is allocated to the latest/current exchange before
the first, user then assistant within each. Latest/current fields retain their tails;
first fields retain their heads. A single exchange is current and retains its tail.
Truncation respects Unicode code points and every affected field is explicitly flagged,
even when its entire text must be omitted. Flag size is included in the envelope budget.
These limits do not alter the relay's **1 MiB** cap or its existing pane/origin/socket rules.
No new endpoint, network listener, filesystem reader, prompt-send path, or conversation
persistence is introduced.

### Verification scope

Real Unix-socket tests cover ancestry, public content/status grouping, delayed persistence,
selection lifecycle, encoded/Unicode limits, and compatibility. Provider lifecycle tests
cover resync, stale authority, malformed records and offline degradation; mounted real
mobile Composer/TerminalView tests include StrictMode and literal untrusted text. Live
rendering in an owned disposable Pi/Herdr session is a separate acceptance gate; these
automated tests do not establish physical iOS Safari or Android Chrome verification.
