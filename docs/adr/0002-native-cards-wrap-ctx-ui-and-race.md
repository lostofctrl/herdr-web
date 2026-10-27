# Native Cards wrap Pi's shared ctx.ui dialogs and race the terminal

In TUI mode Pi only emits `ui_prompt_start {kind, title}`, which carries neither the options nor a way to answer from outside. To show complete Native Cards for `select`, `confirm` and `input`, the Pi Bridge wraps those methods on Pi's shared UI context. It forwards title and options to herdr-web, passes a combined `AbortSignal` to the original terminal dialog, and resolves with whichever answer arrives first: terminal, phone or desktop. The other side is aborted.

`ask_user_question` does not need wrapping, because its own `rpiv:ask-user:prompt` / `rpiv:ask-user:answer` channel already settles first-answer-wins in TUI mode.

## Considered Options

- **Keystroke-only cards built from `ui_prompt_start`**: rejected because `select` cards could not list their options.
- **Wait for an upstream Pi API**: rejected as a blocker. Adopt it and drop the wrapper if Pi ships one.

## Consequences

- The wrapper depends on Pi internals, as `herdr-clipboard-patch.ts` already does. At startup the bridge runs a self-check that the wrap took effect. If it fails, it turns Native Cards off for generic dialogs and reports it, and the terminal dialog plus the dialog-mode Key Bar still work.
- `ctx.ui.custom()` dialogs other than `ask_user_question` stay terminal-only.
