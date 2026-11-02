# Handoff: browser file tabs (PR #37)

As of 2026-11-02, commit `e0ce925`, the last code commit on
`plan-port-pi-web-file-browser-and-editor-to-herdr-web-8c3ee9ba`. This document is a snapshot for
merge review; it is not maintained after that commit. Compare against the branch tip to detect drift.

- Pull request: <https://github.com/lostofctrl/herdr-web/pull/37> — `mergeable: MERGEABLE`,
  `mergeStateStatus: CLEAN` at the time of writing.
- Branch commits, oldest first: `f613b4e` confined file tabs and bridge file service, `023d762`
  watch, search and documented downloads, `c4f2529` file operations plus the pi-web-matched UI,
  `9c6d96c` changelog links, `a1f3df0` upstream contracts after the rebase onto `main`, `98f96bb`
  Composer insert coverage, `966d1ae` mobile stacked-layout scroll fix, `e0ce925` duplicate route
  removal and tree-mutation contract tests.
- Why it exists and what it guarantees: `docs/adr/0003-confined-browser-file-tabs.md`. Feature-by-feature
  parity with the reference implementation, including deliberate non-ports:
  `docs/file-browser-parity.md`. User-facing wording: the `Browser file tabs` and `Bridge: opt-in
  confined file service` entries under `## [Unreleased] → ### Added` in `CHANGELOG.md`.

## What a reviewer is being asked to accept

The bridge gains an opt-in, Linux-only file service that is disabled unless `--file-root` or
`HERDR_WEB_FILE_ROOT` is set. The browser gains local file tabs that read and edit inside that root
without touching the Herdr workspace, tab or pane selection. Saves are conditional on the revision
the editor loaded. Every allowed client shares the root's authority, and the route's host/origin
check is not authentication, so the service is trusted-LAN only.

Security consequences, accepted and recorded in ADR 0003 rather than discovered here: a moved
opened parent keeps the authority it was opened with; hard-link provenance cannot be known; a
non-cooperating local writer can replace the destination between check and rename; a local writer
can substitute the source temp name so a "successful" save publishes different bytes, or swap the
selected entry so a different entry is renamed or deleted. Atomic saves can drop hidden `trusted.*`
xattrs, which an unprivileged process cannot enumerate, so the UI warns before saving. Conditional
saves are not a universal compare-and-swap.

## Verification performed for this snapshot

`npm run check` exits 0 on `e0ce925`: 885 web tests in 93 files, 305 bridge tests (1 ignored), 147
vendored-compat tests, ESLint, both `cargo fmt` checks, the frontend production build, and
`vendor:check`. Both GitHub CI runs on the previous commit `966d1ae` passed; `e0ce925` re-ran the
same local checks.

Browser checks ran in Chromium against a bridge serving this checkout as its file root:

- Opening `README.md` loads 618 lines; leaving the shell through a terminal tab returns to that tab;
  Back and Forward tab history round-trips between the file shell and the terminal.
- Re-entering the shell restores the explorer; a clean read is not kept as a draft.
- 1440x900 and 390x844: at compact width, selecting the space, `+ File tab`, the explorer and opening
  a file all work. The earlier stacked layout rendered the editor below the clipped stage with no
  scroll container; `966d1ae` makes the shell the scroll container at `<= 40rem` and leaves the
  desktop two-column layout unchanged.
- Earlier runs in this branch's history covered content search, external-change reload, draft
  conflict on save, directory copy and confirmed recursive delete, and root re-confirmation after a
  bridge restart.

## Not verified, with the reason

- **Pi mention insertion has never run live.** The chooser lists same-bridge Pi panes and the button
  is enabled, but pressing it writes into a real session's Composer draft, which is not an acceptable
  test in a shared environment. It is covered by unit tests only (the `inserted | blocked |
  unavailable` mapping, and that only the Composer owning that bridge and pane handles the event).
  Exercising it needs a disposable Pi session.
- **Git status and diffs stay off.** No isolation boundary could be verified on the development host
  (WSL2, inherited seccomp, no usable sandbox tool), so the bridge rejects a configured Git metadata
  root at startup. The UI surfaces are not implemented.
- **No directory `fsync` after rename.** Bytes and the file's own metadata are synced before the
  rename; crash durability of the rename itself is unproven.
- **Upload and download acceptance is test-only.** Their framing, caps and headers are covered by
  bridge tests; no browser upload or download was performed in this environment.

## Where to look first

- `bridge/src/file_root.rs`, `bridge/src/file_root/file_read.rs`,
  `bridge/src/file_root/file_read/file_save.rs` — resolution, bounded reads, conditional save.
- `bridge/src/file_mutations.rs`, `bridge/src/file_search.rs`, `bridge/src/file_watch.rs`,
  `bridge/src/file_identity.rs`, `bridge/src/file_service.rs` — operations, search bounds, change
  hints, persistent binding identity, request contract.
- `bridge/src/web_bridge.rs`, `bridge/src/web_bridge/file_http.rs`,
  `bridge/src/web_bridge/file_route_tests.rs` — routes, host/origin policy, admission order.
- `web/src/files/`, `web/src/App.tsx` — explorer, editor, drafts, watch reconnect, mention flow.
