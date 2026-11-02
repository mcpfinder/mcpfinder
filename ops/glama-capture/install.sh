#!/bin/bash
# Install the LaunchAgent: ./install.sh primary   (aic-studio)
#                          ./install.sh fallback  (aic-wfs-mini)
# Prerequisite Keychain items (account $USER): GLAMA_API_KEY,
# MCPFINDER_GLAMA_CAPTURE_R2_ACCESS_KEY_ID, MCPFINDER_GLAMA_CAPTURE_R2_SECRET_ACCESS_KEY.
# Both roles check every 6 h (at most 4 crawls a day per machine) and capture only
# when latest.json is old enough: primary at >= 22 h (so about every 24 h, retrying
# a failed run about 6 h later), fallback at >= 30 h.
# The wrapper self-updates from main; rerun this only when the plist changes.
# Moving from the hourly fallback: the primary needs no reinstall (its plist is
# unchanged and its wrapper self-updates); rerun `install.sh fallback` to go from
# 1 h to 6 h.
# Bucket mcpfinder-glama-capture has a lifecycle rule expiring objects after 3 days.
set -euo pipefail
ROLE="${1:?usage: install.sh primary|fallback}"
case "$ROLE" in primary|fallback) INTERVAL=21600 ;; *) echo "bad role" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="$HOME/Library/Application Support/mcpfinder-glama-capture"
WRAPPER="$BASE/glama-capture-launchd.sh"
PLIST="$HOME/Library/LaunchAgents/com.mcpfinder.glama-capture.plist"
for k in GLAMA_API_KEY MCPFINDER_GLAMA_CAPTURE_R2_ACCESS_KEY_ID MCPFINDER_GLAMA_CAPTURE_R2_SECRET_ACCESS_KEY; do
  security find-generic-password -s "$k" -a "$USER" >/dev/null 2>&1 || { echo "missing Keychain item $k" >&2; exit 1; }
done
mkdir -p "$BASE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 700 "$HERE/glama-capture-launchd.sh" "$WRAPPER"
sed -e "s|@WRAPPER@|$WRAPPER|" -e "s|@ROLE@|$ROLE|" -e "s|@INTERVAL@|$INTERVAL|" -e "s|@LOGDIR@|$HOME/Library/Logs|g" \
  "$HERE/com.mcpfinder.glama-capture.plist.in" >"$PLIST"
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/com.mcpfinder.glama-capture" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"   # RunAtLoad starts a first run now
echo "installed $PLIST (ROLE=$ROLE)"
