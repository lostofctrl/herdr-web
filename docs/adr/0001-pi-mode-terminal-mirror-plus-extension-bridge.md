# Pi mode keeps the TUI and adds an in-process extension bridge, not RPC

Pi mode drives Pi through its real TUI in the Herdr pane and adds a Pi Bridge extension inside that Pi process, instead of running `pi --mode rpc` and rendering an HTML chat like pi-web. Keeping the TUI means every extension, `ctx.ui.custom()` dialog, slash command, `!bash` and steer/follow-up queue keeps working, while the bridge supplies only the state and actions the phone UI needs. A Pi process cannot be in TUI and RPC mode at once, so the bridge is the only way to get structured data from a TUI session.

## Considered Options

- **RPC chat UI (pi-web style)**: rejected. It means rebuilding the transcript renderer, `custom()` extension UIs stop working, and it repeats pi-web's size.
- **Read session JSONL only**: rejected because it is read-only and cannot switch models, abort, or answer dialogs.

## Consequences

- The Composer delivers text as a bracketed paste into the PTY followed by Enter, so Pi's own editor still decides between submit, steer, follow-up, `/command` and `!bash`.
- Images use the same single channel: on send, each attached image is uploaded through herdr-web's existing upload endpoint, and its saved path is pasted together with the text, as a terminal drag-drop would be. Pi's editor then turns it into an attachment. Image bytes never travel through the Pi Bridge.
- Transport: the bridge listens on `$XDG_RUNTIME_DIR/pi-bridge/<HERDR_PANE_ID>.sock` (JSONL), and herdr-web's Rust bridge proxies it over the existing authenticated WebSocket. The phone needs no new port or auth.
- The Pi Bridge lives inside this repository as its own self-contained package (`pi-bridge/`), and the herdr-web side lives in a personal fork in isolated files (`web/src/pi/*`) with minimal hooks into `App.tsx`, so rebasing on upstream stays cheap.
- Without a reachable bridge (Bridge Offline), the pane degrades to the Composer, a static Key Bar and the Chord Composer.
