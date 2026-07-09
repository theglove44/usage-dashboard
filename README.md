# usage-dashboard

Local Codex + Claude Code usage/quota tracker. Two parts:

1. **Live quotas** — `codex-live-limits.mjs` calls `codex app-server`'s
   `account/rateLimits/read` JSON-RPC method directly (free, on-demand,
   account-wide, no thread/session needed), falling back to tailing the most
   recent local rollout jsonl if the RPC fails. `claude-rate-limits.json` is
   written by `~/.claude/statusline-command.sh` on every statusline render
   (Claude Code has no free standalone rate-limit endpoint — see this repo's
   companion project [usage-menubar](https://github.com/theglove44/usage-menubar)
   TODO for the open item there).
2. **Historical dashboard** — `parse-logs.mjs` / `parse-codex-logs.mjs` walk
   session JSONL logs (plus `state_5.sqlite` for Codex) into aggregated
   `*-usage-data.json`, served by `server.mjs` and rendered by `index.html`
   / `codex.html`.

Zero external network calls — everything reads local files or talks to the
already-authenticated local `codex` binary.

## Run

```
node server.mjs 8484
```
then open `http://localhost:8484`.

## Refresh historical data

```
./update-usage.sh
```
Wired into a daily launchd job (`~/Library/LaunchAgents/com.christaylor.claude-usage-update.plist`).
Also invocable via the `/update-usage` Claude Code skill.

## Not committed

Generated data (`*.json`) and logs (`*.log`) are gitignored — they contain
personal session titles, project paths, and cost figures. Only source is
tracked here.

See the [usage-menubar](https://github.com/theglove44/usage-menubar) repo for
the native macOS menu bar app that reads `claude-rate-limits.json` /
`codex-rate-limits.json` from this project.
