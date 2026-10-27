# herdr-web Pi Mode

A Pi-aware layer on top of the herdr-web terminal that makes driving a Pi pane comfortable from a phone first and a desktop second, without replacing the terminal as the source of truth.

## Language

### Surfaces

**Pi Pane**:
A Herdr pane whose foreground program is a Pi session running in its normal TUI mode.
_Avoid_: Pi terminal, agent pane (when Pi specifically is meant)

**Composer**:
The native text box where the user writes a prompt with the device's own keyboard, autocorrect, dictation and IME before it is delivered to the Pi Pane.
_Avoid_: Input box, draft box, prompt field

**Attachment Chip**:
A thumbnail above the Composer for an image that will be sent with the next prompt.
_Avoid_: Upload, preview

**Screenshot Editor**:
The markup surface opened from an Attachment Chip for cropping, redacting and annotating an image before it is sent.
_Avoid_: Image editor, annotator

**Key Bar**:
The row of touch buttons that sends keys that are hard or impossible to press on a phone keyboard, chosen according to the current Pi State.
_Avoid_: Toolbar, shortcut bar, extra keys

**Chord Composer**:
The full modifier-plus-key picker for any key combination the Key Bar does not offer.
_Avoid_: Key picker

**Native Card**:
A touch-native rendering of a blocking Pi question or dialog that the user can answer instead of driving the terminal dialog.
_Avoid_: Popup, modal, toast

**Reader Sheet**:
A pull-up view showing the latest assistant message as selectable, copyable text.
_Avoid_: Transcript, chat view

**Side Panel**:
The collapsible surface holding the model and thinking picker, the command and skill browser, and quick actions for the selected Pi Pane.
_Avoid_: Sidebar (already means the Herdr workspace list)

### Pi integration

**Pi Bridge**:
The extension running inside a Pi Pane's Pi process that publishes Pi State and accepts actions and dialog answers from herdr-web.
_Avoid_: RPC, agent bridge, herdr-web-bridge (that is the Rust server)

**Pi State**:
What the Pi Bridge reports about its session: idle, busy or waiting on a dialog, plus model, thinking level, commands and skills.
_Avoid_: Agent status

**Bridge Offline**:
The condition where a Pi Pane has no reachable Pi Bridge, in which only Composer delivery, a static Key Bar and the Chord Composer remain.
_Avoid_: Fallback mode, legacy mode
