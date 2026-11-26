# Linux owner console: how to ship it

Status: implemented in `apps/linux/` (0.4.0), 2026-11-26; see "As built" below and
`apps/linux/README.md`. Original proposal follows. Scope: a Linux desktop client with the feature set of the
SwiftUI Mac app (`apps/mac`), version 0.4.0 including Teams. Target: Ubuntu 24.04 GNOME,
x86_64 (arm64 if cheap), `.deb` + AppImage, token in the Secret Service keyring.

## What the client must do

Everything in `apps/mac/README.md` plus the Teams contract:

- Sign in with username + console token, verified by `GET /owner/me`; token in the system keyring
  (service `org.antonyuk.agent-relay`, account `<username>@<host>`), URL and username in a plain config file.
- Inbox (held posts and approvals: Approve / Send / Reject), Rooms with threads and messages
  (untrusted text rendered verbatim, no markdown, no links), Feed, Audit, Tokens with revoke, Settings,
  Teams (members, gate, rooms; room `team`, `people`, avatar initials).
- Poll `GET /owner/summary` every 5 s (back off to 30 s), follow `feedCursor`, refetch `/owner/pending`.
  401 signs out. Read-only tokens disable the buttons.
- Notifications with Send / Approve / Reject actions, click opens the item. Pending count as a badge.
- Closing the window keeps the app polling.

The API is plain HTTPS + JSON, so the client is a thin UI over `docs/console-api.md`. All risk is in
the shell around it: keyring, notification actions, tray/badge, packaging.

## Options compared

| Criterion | (a) GTK4 + libadwaita (PyGObject or gtk4-rs/relm4) | (b) Tauri 2 + small web UI | (c) Web UI served by the relay, wrapped | (d) Electron |
| --- | --- | --- | --- | --- |
| Native look on GNOME | Best: real Adwaita, dark mode, HIG | Good with an Adwaita-styled CSS kit; not native widgets | Same as (b) | Same as (b), Chromium look |
| Size | .deb 1-5 MB (Rust) or a few hundred KB of Python; needs system GTK4/libadwaita (Ubuntu 24.04 has libadwaita 1.5) | .deb about 5-10 MB (uses system WebKitGTK); AppImage about 70-90 MB (bundles WebKitGTK) | Same as (b) | .deb/AppImage 90-150 MB |
| Build complexity | .deb easy. AppImage with GTK4/libadwaita is painful (gdk-pixbuf loaders, schemas, icon themes, portals, must be built on the oldest target distro); Flatpak is the natural format, not asked for | `pnpm tauri build` produces .deb and AppImage in one command; official GH Action path | Tauri build plus a UI that must be served and versioned with the relay | `electron-builder` produces .deb and AppImage; mature, heavy |
| Keyring | Python: `libsecret` via gi (`Secret`), trivial. Rust: `oo7` or `keyring` | Rust `keyring` crate (Secret Service backend), 3 lines | Same as (b); a pure web page has no keyring | `keytar` is archived; `safeStorage` uses libsecret but weak API; native module pain |
| Notification actions | Python: `Gio.Notification` buttons work through the GTK app and D-Bus activation (needs an installed `.desktop` file and app id; fragile in AppImage). Rust: `notify-rust` | `tauri-plugin-notification`: desktop actions are supported (buttons from `registerActionTypes`, `onAction`), "as far as the notification server reports it". GNOME reports them | Same as (b) | Electron `Notification` actions are ignored on Linux; needs `node-notifier`/libnotify side code |
| Tray / badge on GNOME | GNOME has no tray; `StatusNotifierItem` needs the AppIndicator extension (Ubuntu ships it enabled). Dock count via `com.canonical.Unity.LauncherAPI` D-Bus works on Ubuntu Dock only | Tray plugin (libayatana-appindicator, same AppIndicator caveat). `set_badge_count` is Unity-launcher only on Linux, so on Ubuntu Dock yes, elsewhere no. Fallback: count in window title and notifications | Same as (b) | Same limits (`app.setBadgeCount` works on Unity only) |
| Reuse for Windows | None (GTK on Windows is poor) | Strong: same UI and Rust core; Tauri builds NSIS/MSI on a Windows runner. macOS stays SwiftUI | Strong for UI, but couples UI release to relay release | Strong, but heaviest |
| Maintenance (small team, next to SwiftUI) | Third UI codebase in a third toolkit; Python or Rust skills only for Linux | Third UI, but TypeScript + a thin Rust core; the Windows client reuses 100% | Avoids a duplicate UI only if the Mac app also moved to web, which we do not want; serving UI from the relay puts the console token in a remotely loaded page (bigger attack surface, CSP and update coupling) | Third UI, biggest runtime to patch (Chromium CVEs) |

Notes behind the table:

- Tauri 2 bundler: `bundle.targets` accepts `deb`, `rpm`, `appimage`; `tauri build --bundles deb appimage`.
  AppImage bundles WebKitGTK (hence the size), the `.deb` depends on system `libwebkit2gtk-4.1-0`, which Ubuntu 24.04 ships.
- `keyring` crate (v3) with the `sync-secret-service` (or `async-secret-service` + `crypto-rust`) feature talks to
  GNOME Keyring / KWallet over D-Bus. `tauri-plugin-stronghold` is a different thing (an encrypted file vault
  with a password the user must supply); it does not use the system keyring, so skip it. Do not use plain
  `tauri-plugin-store` for the token.
- Notification actions: `tauri-plugin-notification` on desktop turns the action types into buttons and reports
  clicks through `onAction` while a listener exists. It must be tested on Ubuntu 24.04 (GNOME Shell shows at most
  the buttons it supports and only for non-resident banners); keep a Rust-side fallback with `notify-rust`
  (`Notification::action` + `wait_for_action`) if the plugin misbehaves.
- (c) is mostly a different packaging of (b). If we ever want a hosted web console, it can be built from the same
  UI sources later; it should not be the primary route, because the console token would live in a page loaded from the relay.

## Pick: (b) Tauri 2, with the network, keyring and polling in Rust, UI in TypeScript

Why:

1. Only (b) and (d) give one-command `.deb` + AppImage and a reusable Windows client; (d) costs 10x the size and
   has no working Linux notification actions. (a) is the most native but dies on AppImage and has no Windows path.
2. The relay API is small JSON over HTTPS, so a thin UI is cheap; the hard Linux bits are keyring, notifications and
   packaging, and Tauri has ready plugins/crates for all of them.
3. The Rust core mirrors `RelayKit` (Models, APIClient, Keychain) and `AppState` (polling, backoff, diffing counters).
   The webview never sees the token: it calls Tauri commands (`signin`, `summary`, `decide`...). That keeps the
   security property the Mac app has (token only in the OS secret store and in process memory of the core).
4. A future Windows client is a CI job, not a project: Credential Manager through the same `keyring` crate, toast
   actions through the same plugin, NSIS/MSI from the same `tauri build`.
5. Native feel: Adwaita-style CSS (own small stylesheet following GNOME HIG colours, `prefers-color-scheme`, system
   font) and the GTK headerbar via Tauri window decorations. Not pixel-native, acceptable for an approval console.

UI framework: vanilla TS with a tiny render helper, or Preact (about 4 KB) if Teams and threads make state messy.
No router, no UI kit. Render all agent text with `textContent` only (the Mac `Text(verbatim:)` rule).

## Layout (proposed)

```
apps/linux/
  package.json            # pnpm, vite, @tauri-apps/cli, @tauri-apps/api, plugin-notification
  src/                    # TS UI: inbox, rooms, feed, audit, tokens, teams, settings
  src-tauri/
    Cargo.toml            # tauri 2, tauri-plugin-notification, keyring, reqwest (rustls), serde, tokio
    tauri.conf.json       # identifier org.antonyuk.agent-relay, bundle.targets [deb, appimage]
    src/                  # models.rs (1:1 with console-api.md), client.rs, keyring.rs, poll.rs, notify.rs, tray.rs
    icons/
  scripts/smoke.ts        # same routes as relay-smoke, against a live relay
```

Models must stay one to one with `docs/console-api.md` (including 0.4.0: `teams` on `/owner/me`,
`GET /owner/teams`, `team`/`teamName`/`people` on rooms). Keep a contract test in the relay repo that
decodes real responses into both the Swift models and the Rust structs.

## Build toolchain on the Ubuntu 24.04 x86_64 box

```sh
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config git \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev \
  libfuse2t64 desktop-file-utils patchelf xdg-utils
# Rust (rustup, stable) and Node + pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
corepack enable && corepack prepare pnpm@11.5.2 --activate     # Node >= 22.5
cargo install tauri-cli --version '^2' --locked                 # or use @tauri-apps/cli via pnpm
```

`libfuse2t64` is only needed to run AppImage tools and the result on 24.04; alternatively export
`APPIMAGE_EXTRACT_AND_RUN=1` in CI. If the AppImage build fails in `strip`, set `NO_STRIP=true`.
The first AppImage build downloads `linuxdeploy` and its plugins (network needed once, cached after).

One command:

```sh
cd apps/linux && pnpm install --frozen-lockfile && pnpm tauri build --bundles deb appimage
# -> src-tauri/target/release/bundle/deb/agent-relay_0.4.0_amd64.deb
# -> src-tauri/target/release/bundle/appimage/agent-relay_0.4.0_amd64.AppImage
```

Wrap it as `apps/linux/scripts/build-linux.sh` (installs nothing, checks the tools above, runs the build,
copies artifacts to `apps/linux/dist/`, writes `SHA256SUMS`). `.deb` Depends are generated by the bundler
(`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`); add `libsecret-1-0`/`gnome-keyring` as
Recommends through `bundle.linux.deb.recommends` if needed.

## CI (GitHub Actions)

- Job `linux-x64` on `ubuntu-24.04`, job `linux-arm64` on `ubuntu-24.04-arm` (free for public repos; for
  private repos it is a paid runner, so make arm64 a tag-only job). Native builds, no cross-compilation.
- Steps: checkout, `apt install` list above, `pnpm/action-setup`, `actions/setup-node` (22), `dtolnay/rust-toolchain@stable`,
  `swatinem/rust-cache`, `pnpm tauri build --bundles deb appimage`, `upload-artifact` (or attach to a release on tag).
  `tauri-apps/tauri-action` can do the same plus the GitHub Release; plain `pnpm tauri build` is simpler to keep.
- Deploy: attach `.deb`, `.AppImage`, `SHA256SUMS` to the GitHub Release `v0.4.0`. No auto-updater in 0.4.0
  (AppImage updater via `createUpdaterArtifacts` can come later; a signed apt repo is overkill now).
- Unit tests (`cargo test`, `pnpm test`) on every push; the smoke script against a throwaway relay with `RELAY_DB=:memory:`-style temp db.

## Test plan on Ubuntu 24.04 GNOME

1. `sudo apt install ./agent-relay_0.4.0_amd64.deb`, launch from the app grid, sign in, restart: signed in
   (token read from the keyring). `secret-tool search service org.antonyuk.agent-relay` shows the item; Sign Out removes it.
2. Run the AppImage on a clean 24.04 VM (no dev packages) and a 22.04 VM (to find the glibc floor); check keyring prompt
   and notifications from inside the AppImage.
3. Notification with Approve/Send/Reject: create a held post with the admin CLI, click each button, verify the relay state.
4. Close the window: polling continues, tray item (AppIndicator extension on) and Dock count on Ubuntu Dock update.
5. Offline banner, 401 sign-out, read-only token, untrusted text, Teams view with a gate-off team.
6. Locked keyring (headless/SSH-less session): the app must show a clear error and a fallback "keep token for this
   session only", never write the token to disk.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| GNOME has no tray and `AppIndicator` can be disabled; Dock badge is Ubuntu-only | Treat tray and badge as best effort; the window title shows the count; notifications are the primary signal; setting "show tray icon" off by default like on Mac |
| Notification action buttons depend on the notification server and the Tauri plugin's desktop support | Test on 24.04 first; fallback `notify-rust` in the Rust core; clicking the body always opens the item, where the buttons are |
| Keyring unavailable or locked (no D-Bus session, non-GNOME desktops) | Detect, show an error, session-only token; never store plaintext. Prefer `async-secret-service` + `crypto-rust` to avoid libdbus linking surprises |
| AppImage 70-90 MB and WebKitGTK version variance across distros | `.deb` is the primary artifact for Ubuntu; AppImage is the portable one; build on the oldest supported distro to keep the glibc floor low |
| Three UI codebases drifting from the API | One contract doc, models 1:1, a smoke/contract test run in CI for all three clients |
| Webview attack surface | Strict CSP, no remote content, `textContent` only for agent text, no shell/fs plugins enabled, capabilities limited to notification + core commands |
| Wayland/X11 oddities in WebKitGTK (blank window on some GPU stacks) | Document `WEBKIT_DISABLE_DMABUF_RENDERER=1` as the workaround; test under Wayland (default on 24.04) |
| Team size: Rust + TS skills | The core is about 600 lines of straightforward code (mirrors RelayKit); no custom native UI toolkit to learn |

## Recommendation

Ship the Linux client as **Tauri 2** in `apps/linux/`: Rust core (reqwest, `keyring` with Secret Service,
notification plugin with actions, polling and diffing as in `AppState`) plus a small TypeScript UI.
Primary artifact `.deb` for Ubuntu 24.04, AppImage as the portable build, both from
`pnpm tauri build --bundles deb appimage` on `ubuntu-24.04` (arm64 on `ubuntu-24.04-arm` for tags only).
Skip GTK4/libadwaita (best look but AppImage pain and no Windows path), Electron (size, no Linux notification
actions) and a relay-served UI (token in a remotely loaded page). Revisit GTK4 + Flatpak only if GNOME-native
fidelity becomes a requirement. First milestone: sign in + keyring + Inbox with notification actions on a real
24.04 GNOME session, since those are the three things that can still sink the choice.

## As built (0.4.0)

Differences from the proposal above:

- Notifications: `notify-rust` on Linux (Send / Reject buttons through `org.freedesktop.Notifications`
  actions, body click opens the item), `tauri-plugin-notification` only on other platforms. The plugin gave
  no reliable action callback on Linux, the crate does.
- No Preact: vanilla TS with a small `h()` helper. The webview has no HTTP or token access; it calls the Rust
  `api` command, which only accepts `/owner/...` paths and GET/POST/PATCH/DELETE.
- Tray icon is on by default (Ubuntu ships the AppIndicator extension); the switch is in Settings.
- Identifier `org.antonyuk.agent-relay`, the same as the Mac app. Debug builds on macOS use the keyring
  service `org.antonyuk.agent-relay.linux-dev` so they never touch the Mac app's Keychain items.
- CI: `.github/workflows/linux-client.yml`, x86_64 only, on `linux-v*` tags and by hand. arm64 not built yet.
- Contract smoke: `cargo test -- --ignored live_relay` with `RELAY_TEST_URL`, `RELAY_TEST_OWNER`,
  `RELAY_TEST_TOKEN` (and `RELAY_TEST_DECIDE=1` to send a held post and reject an approval).
