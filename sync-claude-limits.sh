#!/bin/bash
# Cheap, frequent refresh for both providers' live quota files. Deliberately
# separate from update-usage.sh (which also re-parses the full session log
# history and is too expensive to run every few minutes):
#   - Claude: pull the tiny claude-rate-limits.json snapshot from each known
#     remote device, then re-merge (freshest wins — see claude-live-limits.mjs).
#   - Codex: re-run the account/rateLimits/read RPC and overwrite
#     codex-rate-limits.json. Without this, the file only gets refreshed by
#     the once-daily update-usage.sh run, so the menu bar shows an hours-old
#     reading even though a fresh one is one free RPC call away.
set -euo pipefail

NODE_BIN="/Users/christaylor/.brv-cli/bin/node"
DASHBOARD_DIR="$HOME/.claude/usage-dashboard"
REMOTE_LOGS_DIR="$HOME/.claude/remote-logs"

LOG="$DASHBOARD_DIR/sync-claude-limits.log"
exec >> "$LOG" 2>&1
echo "--- $(date) ---"

# Known devices that run Claude Code and have this same usage-dashboard
# setup installed. Add more "host:dir-name" pairs as devices are added.
REMOTE_DEVICES=(
  "stormbreaker:mac-mini"
)

for entry in "${REMOTE_DEVICES[@]}"; do
  host="${entry%%:*}"
  dir="${entry##*:}"
  mkdir -p "$REMOTE_LOGS_DIR/$dir"
  echo "Syncing claude-rate-limits.json from $host..."
  rsync -az --timeout=5 \
    "$host:~/.claude/usage-dashboard/claude-rate-limits.json" \
    "$REMOTE_LOGS_DIR/$dir/claude-rate-limits.json" \
    2>&1 || echo "WARN: sync from $host failed (offline or not set up yet)"
done

echo "Merging Claude limits..."
"$NODE_BIN" "$DASHBOARD_DIR/claude-live-limits.mjs"

echo "Refreshing Codex limits..."
"$NODE_BIN" "$DASHBOARD_DIR/codex-live-limits.mjs" || echo "WARN: codex rate-limit refresh failed"

echo "Done."
