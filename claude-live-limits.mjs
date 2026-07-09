#!/usr/bin/env node
/**
 * Claude Code has no free standalone rate-limit endpoint (unlike Codex's
 * account/rateLimits/read) — usage data only comes back as a live event
 * during an actual running query. So instead of querying live, this merges
 * the freshest available snapshot across devices:
 *
 *   - This device's own capture: usage-dashboard/claude-rate-limits.json
 *     (written by statusline-command.sh on every statusline render)
 *   - Other devices' captures, synced in by sync-claude-limits.sh into
 *     remote-logs/<device>/claude-rate-limits.json
 *
 * Picks whichever has the newest captured_at and writes it to
 * claude-rate-limits-merged.json, tagged with which device it came from.
 * Since Claude quota is account-wide, the freshest capture from ANY device
 * is the most accurate answer — this just avoids the local file going
 * stale when quota gets burned on a machine you're not sitting at.
 */

import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DASHBOARD_DIR = join(homedir(), ".claude", "usage-dashboard");
const REMOTE_LOGS_DIR = join(homedir(), ".claude", "remote-logs");
const LOCAL_FILE = join(DASHBOARD_DIR, "claude-rate-limits.json");
const MERGED_FILE = join(DASHBOARD_DIR, "claude-rate-limits-merged.json");

async function readSnapshot(file, device) {
  try {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw);
    if (!data.captured_at) return null;
    const ts = Date.parse(data.captured_at);
    if (Number.isNaN(ts)) return null;
    return { device, ts, data };
  } catch {
    return null;
  }
}

async function collectSnapshots() {
  const snapshots = [];

  const local = await readSnapshot(LOCAL_FILE, "local");
  if (local) snapshots.push(local);

  const deviceDirs = await readdir(REMOTE_LOGS_DIR, { withFileTypes: true }).catch(() => []);
  for (const d of deviceDirs) {
    if (!d.isDirectory()) continue;
    const remote = await readSnapshot(join(REMOTE_LOGS_DIR, d.name, "claude-rate-limits.json"), d.name);
    if (remote) snapshots.push(remote);
  }

  return snapshots;
}

export async function getClaudeLiveLimits() {
  const snapshots = await collectSnapshots();
  if (snapshots.length === 0) {
    return { captured_at: null, five_hour: null, seven_day: null, cost_usd: null, model: null, source_device: null, note: "no snapshots found on any device" };
  }
  snapshots.sort((a, b) => b.ts - a.ts);
  const freshest = snapshots[0];
  return { ...freshest.data, source_device: freshest.device };
}

export async function writeMergedSnapshot() {
  const merged = await getClaudeLiveLimits();
  const tmp = `${MERGED_FILE}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(merged, null, 2));
  await rename(tmp, MERGED_FILE);
  return merged;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeMergedSnapshot().then((r) => console.log(JSON.stringify(r, null, 2)));
}
