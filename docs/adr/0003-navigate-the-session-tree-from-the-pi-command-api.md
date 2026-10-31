# Navigate the session tree from the Pi command API, guarded, and keep `/tree` as the full picker

A Session Tree Card must let the phone choose a Pi session-tree entry while the terminal stays
authoritative. Pi's built-in `/tree` picker cannot be driven from outside: it owns its own rendering,
its summary flow and its queued-message restoration, and no extension API opens it.

The Pi Bridge therefore registers its own command, `/herdr-tree`. The command runs in the Pi Pane, so
the terminal starts every picker; it publishes the current tree (bounded rows, ids only) to
herdr-web and waits. The card can only answer with an entry id published for that open picker, and the
command performs the navigation with `ctx.navigateTree(id, { summarize: false })` after re-checking
that Pi is interactive, idle, has no queued messages, holds no editor draft, and still sits on the
same session id and leaf. A new run or any session switch/fork/tree/compaction cancels the picker.

## Considered Options

- **Reuse the built-in `/tree` picker through the terminal**: rejected because a browser cannot answer
  it, and rather than a card it would give the phone a raw TUI.
- **Call `ctx.ui.custom()` with its own tree component**: rejected after a live probe. Escape never
  reached the component in a running TUI and the waiting screen then blocked Ctrl+C exit.
- **Inject `/tree` into the terminal and scrape its output**: rejected. It depends on terminal input
  the bridge cannot prove to be exclusively its own, and on reading a screen it does not own.
- **Wait for an upstream Pi API that exposes summaries and queue restoration to extensions**: not a
  blocker. Adopt it and widen this card if it ships; the guards stay useful either way.

## Consequences

- The card is deliberately smaller than the terminal picker: no summaries, no custom instructions, and
  no queued-message restoration. `/tree` remains the full picker and the documented way to get those.
- Guarded navigation is safer than unguarded navigation, not airtight. An extension that awaits inside
  its own `session_before_tree` hook runs after the final check and can still commit a stale target, so
  the protocol doc states that `/tree` is the safe choice when such a hook is installed.
- The published rows are bounded for a phone. The live leaf is pinned into the payload even past the
  cutoff, so the card always has a `current` row, and filtering only ever searches published rows.
- The protocol gains `tree_picker_open`, `tree_picker_closed`, `tree_picker_answer`,
  `tree_picker_cancel` and a `session_tree_picker` capability. Clients hide the card when the
  capability is absent, so older bridges keep working unchanged.
