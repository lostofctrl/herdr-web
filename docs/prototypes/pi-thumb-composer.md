# Pi thumb composer — disposable mobile experiment

**Not a production proposal or implementation. Do not merge this branch into main.**

Feedback tracker: [issue #14](https://github.com/lostofctrl/herdr-web/issues/14).

Open the running Vite dev server at `/?prototype=pi-composer&variant=A` (also `B` / `C`).
This DEV-only route bypasses the real App, BridgeProvider and native controls. All terminal,
conversation and agent activity is labelled fixture data. No real session is touched; no draft
is persisted. Reload intentionally loses the draft. No new dependencies or test suites.

## Three structures

- **A — Conversation dock:** stacked independently scrollable context/current exchanges,
  full-width input and a horizontal action bar. Familiar reading order, broad text measure.
- **B — Thumb rail:** narrow context strip above an inset working sheet; tall input beside
  a right-hand action cluster. Collapsed launcher is exactly 44×44; less input width and more
  vertical editor footprint than A/C. Landscape flattens the action cluster to stay reachable.
- **C — Context split:** distinct context desk and contrasting current-response desk,
  followed by a compact full-width input. Stronger boundary between old context and current work.

The floating bottom switcher changes variants without losing in-memory draft/pending state.
Left/right arrows also work outside text fields. Its middle button opens Lab, containing the
live state×event table, current measured viewport, thumb-zone toggle and explicit simulations.
The current reply initially scrolls to its end, directly above the input; context scrolls separately.

## Pair sources inspected before implementation

`docs/pi-mode-protocol.md` v1 publishes only the latest assistant text via snapshot / last-message.
It does **not** publish first/current user turns or a bounded conversation history.
`pi-bridge/src/index.ts` replaces the last-message value at each assistant message_end; a tool-only
assistant message can replace useful text. Startup scans `getEntries()`, which includes abandoned
branches, and there is no session-tree subscription for these pairs.

A private read-only structural sample of stored Pi JSONL confirmed v3 session headers,
message entries with id/parentId, string user content and assistant text blocks. No real
conversation text or identifiers were copied into this prototype. The selected live leaf
cannot reliably be inferred by taking the last disk entry: a branch selection may be in memory.

**Future data decision:** obtain a bounded, versioned bridge snapshot derived from the active
`sessionManager.getBranch()` ancestry. Group assistant messages until the next user, select the
last eligible text, and keep an incomplete current user turn. Send first/current pairs only,
deduplicating when they are the same pair. Specify tool-only, abort/error, compaction and branch
switch semantics before implementation. Do not reconstruct conversation from browser draft/history
storage: it lacks agent replies, other clients and branch identity. This branch uses fixtures
because v1 cannot faithfully supply the requested data; it does not change the protocol.

## State contract

Mode and keyboard geometry are separate. Blur / visualViewport resize never implicitly collapse.
Focused mode removes the terminal entirely and sizes the shell to visualViewport height/width and
its offsetTop/offsetLeft. Primary actions occupy the visible shell's bottom third; controls are
at least 44×44 CSS pixels with at least 8px separation. The bottom prototype switcher is included
in the audits (it would not ship).

| Event | Collapsed | Focused | Sending | Dialog open |
| --- | --- | --- | --- | --- |
| Open | Focused + request input focus | Stay | Stay | Stay |
| Send | Open first | Capture prompt; sending | Ignore duplicate | Block |
| Agent reply | Update latest | Update latest | Finish current pair | Update behind dialog |
| Keyboard closes without blur | Stay | Stay fullscreen | Stay fullscreen | Stay |
| Rotation / resize | Refit terminal | Refit viewport | Refit viewport | Refit viewport |
| Background / foreground | Keep memory | Keep draft + mode | Keep pending | Keep draft + dialog |
| Cancel | No-op | Draft-choice dialog | Stop fixture; keep draft | Close; keep draft |
| Terminal | Stay | Collapse; keep draft | Collapse; keep pending | Close; collapse; keep draft |

A completed submitted draft clears only if unchanged since Send; edits made while waiting survive.
Sending is deliberately manual: Lab → Agent reply completes the fixture, allowing Cancel to be timed.
The Background button simulates an event; real visibilitychange also preserves in-memory state.
The Keyboard button / `&keyboard=1` subtracts **300px of geometry**, not a native keyboard.
Do not enable that simulation when evaluating a real phone keyboard.

## Reproduce the evidence

Use the exact worktree's Localdev profile/run; set `NODE_ENV=development` explicitly in its
Vite command (an inherited production value causes inconsistent React refresh transforms).
The preview is DEV-only; a production build intentionally cannot serve the prototype.

Launch an owned, uniquely named Chromium session using `playwright_launch`, then:

```sh
playwright-cli -s=SESSION run-code --filename=web/src/pi-mode/prototype/capture.cjs
```

Close the owned browser afterwards. Inspect `### Error` even if playwright-cli exits zero.
The script writes a private `/tmp/pi-thumb-composer-evidence/` directory, including `audit.json`,
`index.html` and 18 PNGs: A/B/C × collapsed/focused/focused with keyboard geometry × iPhone 13
(390×844) / Pixel 7 (412×915). Both are **Chromium mobile emulation**, not Safari device runs.
The [gallery](pi-thumb-composer-evidence/index.html) and
[JSON](pi-thumb-composer-evidence/audit.json) contain exact rectangles and flow results.
Captured evidence is committed beside this document on the throwaway branch only.

The audit enumerates visible interactive targets (including disabled controls), rejects sizes
below 44×44, gaps below 8px, primary actions outside the bottom third and horizontal overflow.
Occluded controls behind a modal are excluded via hit testing. It also verifies terminal removal,
300px simulated inset, sending/cancel/draft/dialog flows, reply arrival, resize without blur,
landscape geometry, variant switching, and absence of backend requests or browser storage writes.
These checks establish geometry/fixture behavior, **not** native IME, Safari or one-thumb comfort.

### Recorded verification

- 18/18 screenshots captured; 27 audited states including dialogs, Lab and landscape.
- 168 interactive rectangles checked, minimum width/height 44px; zero target, gap, bottom-third
  or overflow failures. All three expanded interaction flows passed.
- No backend traffic or local/sessionStorage writes observed in isolated browser contexts.
- `PATH="$HOME/.cargo/bin:$PATH" npm run check` passed: lint/vendor checks, 608 web tests,
  147 compatibility tests, 165 bridge tests, 36 Pi bridge tests, supporting script tests,
  frontend production build and bridge build. Existing >500kB bundle warning remains.
- Production JS excludes the fixture-only prototype strings. Normal dev bootstrap also loads.
- Earlier checks caught missing script lint globals, missing Vite ImportMeta types and a collapsed
  state label that incorrectly prioritized pending delivery; corrected and verified again.
- No physical-phone timings, native keyboard, Safari, real Pi delivery or real background lifecycle
  measurement was performed. These remain explicit follow-up, not passing claims.

## Real-phone timing task — required before choosing a winner

Use Safari on iPhone and Chrome on Pixel over the private Localdev Tailscale URL shared in chat.
All participants must be on the tailnet. Localdev may stop the server when this agent turn settles;
run `/localdev start` in this checkout to reactivate the same URL. Never publish the private hostname.

Hold the phone one-handed. Leave keyboard simulation OFF. Repeat in counterbalanced order
(A/B/C, B/C/A, C/A/B); record browser/device, hand, seconds and mistakes for each task separately:

1. Open composer; read the **last sentence** of the latest reply aloud. Stop the reading timer.
2. Type `Keep the draft when I rotate.` and press Send. Stop the follow-up timer.
3. Press Cancel while Working. Stop the cancel timer; confirm the full draft remains.
4. Press Terminal. Stop the return timer; confirm no CLI composer, reopen and confirm kept draft.

Then dismiss the keyboard **without blurring**, rotate, background/foreground, and scroll both
exchange regions. Record any obscured input/action, unexpected collapse, accidental Send/Cancel,
scroll trap or lost draft. Lab → Agent reply also lets you check reply arrival while collapsed.

| Device / browser / hand | Variant / order | Read s | Follow-up s | Cancel s | Terminal s | Errors / reach / keyboard notes |
| --- | --- | --- | --- | --- | --- | --- |
| Pending physical run | A | — | — | — | — | Not measured |
| Pending physical run | B | — | — | — | — | Not measured |
| Pending physical run | C | — | — | — | — | Not measured |

## Provisional verdict and deletion rule

**A is the provisional baseline to take into phone testing, not a measured usability winner.**
It keeps a wide input and familiar reading order without B's narrower editor or C's stronger
context break. B buys the smallest collapsed launcher; C is the alternative for people who
need old/current context to be more visibly distinct. Geometry passes do not prove any is fastest.
Choose only after the physical timing/error/reach notes above. Do not retrofit production now.

If active-branch data cannot be exposed safely, stop rather than presenting stale/partial pairs.
If phones show no useful advantage, delete the experiment. Otherwise implement only the winning
idea in a separate reviewed change after defining the bridge snapshot. Remove the query guard,
prototype directory and extracted bootstrap as one rollback; no real user state needs migration.
