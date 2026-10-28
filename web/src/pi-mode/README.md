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
