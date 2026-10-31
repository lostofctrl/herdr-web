# Release Process

`herdr-web` is a private, vendored web app release. Releases create Git tags and GitHub releases.
They do not publish npm packages, and the package versions are not release versions.

## Prerequisites

- Clean `main` branch.
- Node.js 22 or newer.
- Rust stable.
- JDK 21 and Android SDK when validating the Android shell.
- GitHub CLI authenticated as a user that can create releases.
- A local Herdr `v0.9.0` or newer session reporting terminal protocol `22` for browser and packaged
  bridge smoke testing.

## Prepare

1. Confirm the changelog has user-facing notes under `## [Unreleased]`.
   Entries merged through pull requests should include the PR number or link before the PR is
   merged.
2. Confirm the vendored Herdr compatibility crate is intentional and clean:

```bash
scripts/check-vendor.sh
```

3. Run the full automated check:

```bash
npm run check
```

Do not cut a release without bridge test/build coverage.

## Package Artifacts

Build or provide platform artifacts immediately after cutting the GitHub release, using the final
release commit or tag created by the release script. If you made any pre-release artifacts before
the release script stamped `CHANGELOG.md`, rebuild them from the released `main`/tag with the final
`vX.Y.Z` value before upload. Use the documented packaging commands and any supplemental local build
instructions for the release operator's environment. Do not commit generated tarballs, APKs, or
build-service outputs.

Linux desktop tarball:

```bash
npm ci
npm ci --prefix web
scripts/package-tarball.sh vX.Y.Z linux-x86_64
```

macOS ARM desktop tarball, run on an Apple Silicon Mac:

```bash
npm ci
npm ci --prefix web
scripts/package-tarball.sh vX.Y.Z macos-arm64
```

macOS Intel desktop tarball, run on an Intel Mac:

```bash
npm ci
npm ci --prefix web
scripts/package-tarball.sh vX.Y.Z macos-x86_64
```

Android debug APK:

```bash
npm ci
npm ci --prefix web
npm run android:build:debug
```

The desktop tarballs are written to `dist-packages/`. The debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.

Before uploading or distributing any tarball or APK, inspect the artifact and confirm it matches the
documented release layout, platform, version, and source commit/tag. For desktop tarballs, list the
archive contents and verify the wrapper, bridge binary, bundled `web/dist`, and README are present.
For APKs, run the package, version, signature, and alignment checks in
[docs/android.md](android.md).

To stage the current debug APK under the release asset name for private testing:

```bash
mkdir -p dist-packages
cp android/app/build/outputs/apk/debug/app-debug.apk dist-packages/herdr-web-vX.Y.Z-android-debug.apk
```

For a public release, build a signed release APK instead and use the non-debug release asset name:

```text
dist-packages/herdr-web-vX.Y.Z-android.apk
```

## Browser Smoke

Start or attach a Herdr `v0.9.0` or newer session reporting terminal protocol `22`:

```bash
herdr
```

Build and run the web bridge:

```bash
npm run build
scripts/run-bridge.sh
```

Open `http://127.0.0.1:8787` and verify:

- The app loads the workspace, tab, pane, and split layout snapshot.
- Multiple browser clients can attach to the same terminal.
- Pane selection syncs between browser clients.
- Typing, mobile text input, stage-only input, tap-focus setting, scrolling, and refit work.
- New tabs can launch Shell and every enabled managed built-in agent.
- Split right/down can launch Shell and every enabled managed built-in agent.
- A custom preset launches its exact configured `argv`, including a wrapper or SSH-shaped command,
  without a built-in agent executable being prepended.
- A forced managed-agent launch failure removes the tab or split created for that launch.
- Upload button, paste upload, and drop upload place shell-quoted file paths in the terminal.
- Pane notes can be created, edited, reloaded, and recovered from the Notes view.
- Binding to `HOST=0.0.0.0` is only used on a trusted network.

Repeat the startup, terminal attach, and launcher checks with an unpacked desktop tarball before
uploading it. Confirm the bridge rejects every protocol other than `22`
instead of serving a partially compatible UI.

### Disposable Pi native-card checks

Native cards can be verified without touching the operator's own Herdr, Pi, or browser sessions by
running everything against a throwaway home and runtime directory:

```bash
FIX=$(mktemp -d)
mkdir -p "$FIX"/{home,config,data,cache,run,agent,sessions,tmp}
env -i HOME="$FIX/home" XDG_CONFIG_HOME="$FIX/config" XDG_DATA_HOME="$FIX/data" \
  XDG_CACHE_HOME="$FIX/cache" XDG_RUNTIME_DIR="$FIX/run" TMPDIR="$FIX/tmp" \
  PI_CODING_AGENT_DIR="$FIX/agent" PI_CODING_AGENT_SESSION_DIR="$FIX/sessions" \
  PI_OFFLINE=1 PATH="$PATH" herdr --session disposable server
```

The isolated server writes its socket to `$FIX/config/herdr/sessions/disposable/herdr.sock`.
Create a pane and start Pi inside it with a fixture extension that opens the dialogs under test:

```bash
herdr --session disposable workspace create --cwd "$PWD" --label disposable
herdr --session disposable pane run <PANE_ID> pi --offline --no-extensions --no-session \
  --extension "$PWD/pi-bridge/src/index.ts" --extension "$FIX/fixture.ts"
```

Run `npm run dev` with the same `XDG_RUNTIME_DIR`, `HERDR_SOCKET_PATH` set to that socket, and a
unique `HERDR_WEB_BRIDGE_PORT` and `HERDR_WEB_DEV_PORT`. Then verify in the browser:

- A `select`, `confirm`, and `input` dialog each render a native card while the terminal selector
  stays authoritative.
- Answering in the card delivers the exact value to Pi, including whitespace, brackets, and `$`; an
  empty input submits an empty string; Cancel returns a cancellation.
- Keystrokes typed while a card is focused do not reach the Pi editor after the card closes.
- Double-clicking an option delivers one answer.
- Answering in the terminal removes the card instead of leaving a stale card.
- The mobile viewport renders and submits the same cards.
- The Pi side panel shows the terminal guidance for session picker, tree, settings, and, only when a
  `/btw` command is in the catalog, side conversation.

Stop the isolated Herdr server and delete `$FIX` when finished.

## Cut

Choose the GitHub release version explicitly and run:

```bash
node scripts/release.mjs v0.1.0
```

The script:

- requires a clean `main` branch
- promotes `CHANGELOG.md` from `Unreleased` to the release version/date
- removes empty unused subsections from the released version notes
- runs `npm run check`
- increments Android `versionCode` by one and sets `versionName` to the release version in
  `android/app/build.gradle`
- commits `Release vX.Y.Z`
- tags `vX.Y.Z`
- pushes `main` and the tag atomically
- creates a GitHub release with notes extracted from `CHANGELOG.md`
- opens the next `## [Unreleased]` changelog section and pushes it

The release script does not upload binary artifacts. Upload separately packaged tarballs and APKs
manually after the release exists.

Android version metadata is part of the tagged release commit. Do not increment it again when
building artifacts: all builds from the same tag must retain the same `versionCode` and
`versionName`. Normal Android sync/build commands do not change these values. npm package versions
remain independent of release versions.

## Android Validation

Before distributing Android builds, follow [docs/android.md](android.md): run
`npm run android:build:debug`, and smoke test bridge configuration on a device or emulator with a
bridge started using `--allow-origin http://localhost`. Revisit the Android backup policy before
adding any pairing token or other secret storage.

## Upload Artifacts

Upload release artifacts manually with GitHub CLI after `node scripts/release.mjs vX.Y.Z` creates
the release. Upload only artifacts built from the final release commit or tag, and inspect each
artifact before upload.

Upload the Linux tarball from the Linux build host:

```bash
gh release upload vX.Y.Z \
  dist-packages/herdr-web-vX.Y.Z-linux-x86_64.tar.gz \
  dist-packages/herdr-web-vX.Y.Z-linux-x86_64.tar.gz.sha256
```

Upload the macOS ARM tarball from the Apple Silicon Mac build host, or copy it to the release
operator machine first:

```bash
gh release upload vX.Y.Z \
  dist-packages/herdr-web-vX.Y.Z-macos-arm64.tar.gz \
  dist-packages/herdr-web-vX.Y.Z-macos-arm64.tar.gz.sha256
```

Upload the macOS Intel tarball from the Intel Mac build host, or copy it to the release operator
machine first:

```bash
gh release upload vX.Y.Z \
  dist-packages/herdr-web-vX.Y.Z-macos-x86_64.tar.gz \
  dist-packages/herdr-web-vX.Y.Z-macos-x86_64.tar.gz.sha256
```

Upload the Android debug APK after it has the final debug asset name:

```bash
gh release upload vX.Y.Z dist-packages/herdr-web-vX.Y.Z-android-debug.apk
```

If every artifact has been copied to one machine, the same paths can be uploaded in one
`gh release upload` invocation.

## After

- Confirm the GitHub release exists and points at the expected tag.
- Confirm release assets and checksum files are attached.
- Confirm `CHANGELOG.md` on `main` has a fresh empty `## [Unreleased]` section.
