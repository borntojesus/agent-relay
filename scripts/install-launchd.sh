#!/bin/sh
# Installs (or updates) the relay as a macOS launchd agent of the current user.
#
#   RELAY_HOST=<address> RELAY_PORT=<port> scripts/install-launchd.sh [install|uninstall|status]
#
# Runs src/index.ts from this checkout. Data and log live outside the repo:
#   database  ~/Library/Application Support/agent-relay/relay.db
#   log       ~/Library/Logs/agent-relay.log
# Optional: RELAY_LABEL (default local.agent-relay), RELAY_ENV_FILE (a file with
# extra KEY=value lines, e.g. RELAY_BOT_TOKEN_<OWNER>; loaded at start, never copied).
set -eu
cmd="${1:-install}"
label="${RELAY_LABEL:-local.agent-relay}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
plist="$HOME/Library/LaunchAgents/$label.plist"
data="$HOME/Library/Application Support/agent-relay"
logf="$HOME/Library/Logs/agent-relay.log"
node="$(command -v node)"
uid="$(id -u)"

case "$cmd" in
  uninstall)
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "removed $label (data kept in $data)"
    exit 0 ;;
  status)
    launchctl print "gui/$uid/$label" 2>/dev/null | grep -E 'state|pid|last exit' || echo "$label not loaded"
    exit 0 ;;
  install) ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac

: "${RELAY_HOST:?set RELAY_HOST (the address to listen on)}"
: "${RELAY_PORT:?set RELAY_PORT}"
mkdir -p "$data" "$HOME/Library/LaunchAgents"
chmod 700 "$data"
envfile="${RELAY_ENV_FILE:-}"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>[ -n "\$ENV_FILE" ] &amp;&amp; [ -f "\$ENV_FILE" ] &amp;&amp; set -a &amp;&amp; . "\$ENV_FILE" &amp;&amp; set +a; exec "$node" src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_HOST</key><string>$RELAY_HOST</string>
    <key>RELAY_PORT</key><string>$RELAY_PORT</string>
    <key>RELAY_DB</key><string>$data/relay.db</string>
    <key>ENV_FILE</key><string>$envfile</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$logf</string>
  <key>StandardErrorPath</key><string>$logf</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
echo "installed $label: http://$RELAY_HOST:$RELAY_PORT, db $data/relay.db, log $logf"
