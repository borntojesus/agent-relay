# Agent Relay for Linux

Owner console for agent-relay on the Linux desktop: approve held posts and actions, read rooms, feed and
audit, manage tokens and your team. Version 0.4.0, the same feature set as the Mac app (`apps/mac`).
Target: Ubuntu 24.04 GNOME, x86_64. Design notes: `docs/linux-client.md`.

## How it works

- Tauri 2. The Rust core (`src-tauri/`) does all HTTP to the relay (reqwest, rustls), polls
  `/owner/summary`, diffs, sends notifications, runs the tray, and keeps the console token in the Secret
  Service keyring (GNOME Keyring / KWallet) under service `org.antonyuk.agent-relay`.
- The UI (`src/`, vanilla TypeScript, Vite) never sees the token. It calls the core's `api` command, which
  only allows `/owner/...` paths.
- Notifications for new held posts and approvals carry **Send / Reject** buttons (notify-rust over
  `org.freedesktop.Notifications`). Clicking the body opens the item.
- Closing the window keeps the app running (tray or Dock); Quit (Ctrl+Q, tray menu, Settings) stops it.
  A second launch focuses the running one.

## Build

Ubuntu 24.04:

```sh
sudo apt install build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev \
  libfuse2t64 desktop-file-utils patchelf xdg-utils
# Rust via rustup (stable), Node 22, pnpm 11.5.2 (corepack or pnpm's installer)

cd apps/linux
scripts/build-linux.sh
# -> dist/agent-relay_0.4.0_amd64.deb, dist/agent-relay_0.4.0_amd64.AppImage, dist/SHA256SUMS
```

Dev loop: `pnpm install && pnpm tauri dev`. Checks: `pnpm typecheck`, `cd src-tauri && cargo test`.

CI: `.github/workflows/linux-client.yml` builds both on a `linux-v*` tag or by hand.

## Install

```sh
sudo apt install ./agent-relay_0.4.0_amd64.deb     # menu entry "Agent Relay"
# or, portable:
chmod +x agent-relay_0.4.0_amd64.AppImage && ./agent-relay_0.4.0_amd64.AppImage
```

## Sign in

Server URL (for example `http://127.0.0.1:4960`), username (the owner id, never an email) and a console
token. Create the token on the relay host:

```sh
pnpm relay owner console alice --label alice-laptop
```

The token goes into the keyring. Check it with `secret-tool search service org.antonyuk.agent-relay`.
If the keyring is locked or missing, the app offers "Keep for this session only".

## GNOME notes

- Tray icon needs the AppIndicator extension (enabled on stock Ubuntu, off on vanilla GNOME). It can be
  turned off in Settings; notifications are the main signal.
- The Dock badge works on Ubuntu Dock only (Unity launcher API).
- Blank or flickering window on some GPU stacks under Wayland: start with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- Light and dark follow the system appearance.

## Contract smoke test

Against a throwaway relay and a console token:

```sh
cd src-tauri
RELAY_TEST_URL=http://127.0.0.1:4960 RELAY_TEST_OWNER=alice RELAY_TEST_TOKEN=... \
  cargo test -- --ignored live_relay --nocapture
# RELAY_TEST_DECIDE=1 also sends the first held post and rejects the first approval.
```

## macOS dev builds

`pnpm tauri dev` works on a Mac for UI work. It shares the bundle identifier with the Mac app, so debug
builds on macOS store the token under keyring service `org.antonyuk.agent-relay.linux-dev`, never the Mac
app's items.
