# Pi mode internals

Notes that back decisions in `web/src/pi-mode/`. The user-facing behaviour stays in
the main `README.md`; this file records verification evidence and seams for the next
change.

## Verified: how Pi's TUI turns a pasted absolute image path into an attachment

Checked against the locally installed `@earendil-works/pi-coding-agent@1.4.0`
(`dist/bundle/cli.js`; sources under the package's `dist/`). **The TUI editor does not
convert a pasted absolute image path into an editor-level attachment.** Pi's own
image paste is path-based, and pixels attach only when the model reads that path.

Evidence:

- `modes/interactive/interactive-mode.js:2439-2493` — Pi's clipboard-image paste
  writes the bytes to a temp file and inserts the **path as text** into the editor
  (`this.editor.insertTextAtCursor?.(filePath)` at `:2486`). Copied files are also
  inserted as paths (`:2460-2469`).
- `node_modules/@earendil-works/pi-tui/dist/components/editor.js:1050-1083` —
  `handlePaste` normalises the bracketed paste and inserts it verbatim (line-ending
  normalisation, a leading space before `/`, `~`, `.` paths). No image detection, no
  attachment conversion.
- `modes/interactive/interactive-mode.js:2691-2697` and `:2660-2676` — submitting
  calls `session.prompt(text)` / `session.prompt(text, { streamingBehavior: "steer" })`
  with **no** `images` argument.
- `core/agent-session.js:1652` — `session.prompt` receives images only from
  `options?.images`; nothing parses paths out of the text.
- `core/tools/read.js:84-107` (tool description at `:53`) — the `read` tool turns a
  supported image file into an `image` content block (“Images are sent as
  attachments”), which is how a pasted path becomes pixels.
- `cli/file-processor.js:12-69` — path→image attachment conversion exists only for
  CLI `@file` arguments (called from `main.js:176`), not for interactive prompts.

Consequence for Attachment Chips: uploading first and pasting the uploaded paths
ahead of the draft is Pi's real image delivery path: the prompt carries the path and
Pi's own `read` tool turns it into an image block. There is no source evidence for an
editor-level conversion, so this module does not claim one.

## Attachment Chips

- `PiComposer.tsx` owns chips, gallery/camera input (`accept="image/*"`), paste and
  drag-drop. Drag/drop/paste of images on a Pi Pane is claimed before
  `TerminalView`'s pane-level upload handler (`TerminalView.tsx`, `piComposerHandlesPayload`);
  non-image files and every non-Pi pane keep the existing upload behaviour.
- On Send, `onUploadImages` (wired in `TerminalView.tsx` to the existing
  `uploadWithOverwritePrompt` + `/api/uploads` flow, including the conflict prompt)
  uploads every chip sequentially. Only after all uploads resolve does
  `piComposerDeliveryParts(text, paths)` produce one bracketed paste with the
  space-separated paths in chip order followed by the draft, then Enter.
- Failures (upload rejected, terminal detached, edited image undecodable) keep the
  draft and chips and show a `role="alert"` message.
- Bridge Offline (no Pi Bridge socket) does not matter here: chips, uploads and
  delivery only depend on the terminal WebSocket and the bridge's HTTP upload
  endpoint.

## Screenshot Editor boundary

`web/src/pi/screenshot/` is self-contained. `PiComposer` loads the chip image's
natural size, mounts `<ScreenshotEditor image onSave onCancel />`, and on Save
replaces only that chip's bytes with the exported PNG (`piComposerEditedAttachment`);
Cancel keeps the original. Export is always PNG, so the chip is renamed to `.png`
before upload.

Known limit: upload names may contain spaces (the bridge sanitizer keeps them), and
paths are pasted space-separated, so such a path is ambiguous to the `read` tool. Pi's own clipboard paste uses newlines for this reason; if this bites,
switch `piComposerPromptText` to newline separation.

## Composer completion contract

- `composer-suggest/` owns triggering, ranking and insertion. A typed `/`, `@` or the
  dedicated buttons all funnel into `insertSuggestionTrigger`/`pickSuggestion`, so one
  formatter decides the inserted text: `/name` for commands, `/skill:name` when the
  bridge advertised `skills_catalog`, and `@path` with quoting for paths that contain
  spaces or shell characters.
- File search debounces 200 ms, caps the request at 50 paths and the list at 20 rows,
  and tags each request with its query and pane so a late reply from an older query or
  a closed pane is dropped. Loading and failure states are visible instead of silent.
- Keyboard acceptance requires Enter/Tab without Ctrl, Meta or Alt and never fires
  during an IME composition; Escape closes the popup without closing the Composer, and
  blur closes it so a stale list cannot be picked later.

## Model picker

`piModelPicker.ts` holds the pure identity (`piModelKey`) and AND-search
(`filterPiModels`) helpers; `PiModelPicker.tsx` is the only model control, used by
`PiComposer` (compact) and `PiSidePanel`. Requests are keyed by provider+id plus pane
identity, the panel stays open on failure to show the error, and the displayed model
always comes from Pi State, never from the requested value.

## Prompt recall

`piComposerHistory.ts` keeps prompts in a module-level map keyed by bridge and pane,
bounded to 50 entries and 16 KiB UTF-8 per entry, suppressing adjacent duplicates and
skipping blank or oversized text. The history itself never touches `localStorage`, and
recalling is transient: `usePiComposerDraft` returns a second setter that changes the
draft without writing it, so browsing an old prompt never puts that text back on disk.
Only text the user types or edits is persisted, exactly like before. A delivery clears the
stored draft only while it still holds the delivered text (`clearPiComposerDraftIf`), so a
prompt recalled or retyped while the send was in flight stays, and the delivered one cannot
come back on reload. `PiComposer` records
from the delivery callback, so only a fully delivered paste plus Enter is remembered;
a partial delivery remembers the original text once its recovery send lands, and
`App` prunes the map with the same pane retention as drafts. Up and Down step through
the list from the draft edges and restore the live draft at the bottom.

`PiComposerHistory.tsx` renders the same list as a searchable panel (AND search over
lower-cased terms, newest first, Clear history with an empty state). It only reports a
pick; the Composer replaces the draft, puts the caret at the end and restores focus, so
no row can send.

## One popup at a time

Completion, the model picker and history never overlap. Typing a `/` or `@` prefix
closes the model and history panels; opening either closes completion. `PiModelPicker`
takes an optional controlled `open`/`onOpenChange` pair for that arbitration and stays
uncontrolled in the Side Panel.

## Key Bar and Composer ownership

`piKeyBarKeys.ts` deliberately has no `slash` or `at` keys: those triggers live in the
Composer's meta row, so the Key Bar has no open/closed visibility state to keep in sync.
The idle `history` key (`↑ Previous prompt`) stays, because it is Pi's own terminal
input and still works while the Composer is closed.

## Side panel insertion

`pi/sidepanel/piComposerInsert.ts` dispatches a cancelable insert event carrying the
text and the merged fallback value. A mounted Composer cancels it and appends the text
to the draft it is actually showing, because recall is transient and the stored draft
can be older than the field; only when no Composer handles the event does the helper
write the merged value itself. Any authored change — typing, a `/` or `@` trigger, a
completion pick, a side-panel insert — ends prompt browsing first, so recall can never
overwrite text the user just produced.
