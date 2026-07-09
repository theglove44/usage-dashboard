#!/bin/bash
# Sync Claude Code session logs from Mac Mini and regenerate usage data.
# Runs as a daily launchd job.

set -euo pipefail

NODE_BIN="/Users/christaylor/.brv-cli/bin/node"

LOG="$HOME/.claude/usage-dashboard/update.log"
exec >> "$LOG" 2>&1
echo "--- $(date) ---"

# Sync remote logs (continue on failure — Mac Mini may be offline)
echo "Syncing from Mac Mini..."
rsync -az office:~/.claude/projects/ "$HOME/.claude/remote-logs/mac-mini/" || echo "WARN: rsync failed (Mac Mini offline?)"

# Regenerate usage data
echo "Parsing logs..."
"$NODE_BIN" "$HOME/.claude/usage-dashboard/parse-logs.mjs"

echo "Parsing Codex logs..."
"$NODE_BIN" "$HOME/.claude/usage-dashboard/parse-codex-logs.mjs"

echo "Done."
