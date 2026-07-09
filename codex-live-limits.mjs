#!/usr/bin/env node
/**
 * Live Codex rate limits via `codex app-server`'s account/rateLimits/read
 * JSON-RPC method — a free, on-demand, account-wide read (no thread/session
 * needed) authenticated with the OAuth creds already in ~/.codex. Since
 * Codex quota is tracked server-side per account, this reflects usage from
 * every device signed into the same account, not just this machine.
 *
 * Falls back to tailing the most recent local rollout-*.jsonl file (the old
 * approach) if the app-server RPC fails for any reason (not logged in,
 * codex binary missing, timeout, etc.) — that fallback only reflects usage
 * from sessions run on this machine.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const RPC_TIMEOUT_MS = 8000;

// Spawns `codex app-server`, does the initialize handshake, calls
// account/rateLimits/read, then kills the process. Never writes anything —
// this is the same subprocess Codex itself runs during normal use.
async function getCodexLiveLimitsFromRpc() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      fn(val);
    };

    const timer = setTimeout(() => done(reject, new Error("app-server RPC timed out")), RPC_TIMEOUT_MS);

    let child;
    try {
      child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return done(reject, err);
    }

    child.on("error", (err) => done(reject, err));
    child.stderr.on("data", () => {}); // drain, ignore

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 0) {
        if (msg.error) return done(reject, new Error(`initialize failed: ${msg.error.message}`));
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1 });
      } else if (msg.id === 1) {
        if (msg.error) return done(reject, new Error(`account/rateLimits/read failed: ${msg.error.message}`));
        done(resolve, msg.result);
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "usage_menubar", title: "Usage Menu Bar", version: "1.0.0" } },
    });
  });
}

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

// List directory entries (names only), sorted descending, directories only unless files=true.
async function listSortedDesc(dir, { filesOnly = false, dirsOnly = false } = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => (dirsOnly ? e.isDirectory() : filesOnly ? e.isFile() : true))
    .map((e) => e.name)
    .sort()
    .reverse();
}

async function findRecentCandidates() {
  const candidates = [];

  const years = (await listSortedDesc(CODEX_SESSIONS_DIR, { dirsOnly: true })).slice(0, 2);
  for (const year of years) {
    const yearDir = join(CODEX_SESSIONS_DIR, year);
    const months = (await listSortedDesc(yearDir, { dirsOnly: true })).slice(0, 2);
    for (const month of months) {
      const monthDir = join(yearDir, month);
      const days = (await listSortedDesc(monthDir, { dirsOnly: true })).slice(0, 3);
      for (const day of days) {
        const dayDir = join(monthDir, day);
        const files = await readdir(dayDir).catch(() => []);
        for (const f of files) {
          if (f.startsWith("rollout-") && f.endsWith(".jsonl")) {
            candidates.push(join(dayDir, f));
          }
        }
      }
    }
  }

  return candidates;
}

async function fullScanFallback() {
  const candidates = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) candidates.push(full);
    }
  }
  await walk(CODEX_SESSIONS_DIR);
  return candidates;
}

async function findMostRecentRolloutFile() {
  let candidates = await findRecentCandidates();
  if (candidates.length === 0) {
    candidates = await fullScanFallback();
  }
  if (candidates.length === 0) return null;

  let newest = null;
  let newestMtime = -Infinity;
  for (const file of candidates) {
    const st = await stat(file).catch(() => null);
    if (!st) continue;
    const mtimeMs = st.mtimeMs;
    if (mtimeMs > newestMtime) {
      newestMtime = mtimeMs;
      newest = { file, mtime: st.mtime };
    }
  }
  return newest;
}

async function findLastTokenCountEvent(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload?.rate_limits) {
      return entry.payload;
    }
  }
  return null;
}

async function getCodexLiveLimitsFromRollout() {
  const base = {
    captured_at: new Date().toISOString(),
    primary: null,
    secondary: null,
    plan_type: null,
    source_file: null,
    source_mtime: null,
    source: "local_rollout",
  };

  try {
    const recent = await findMostRecentRolloutFile();
    if (!recent) {
      return { ...base, note: "no codex sessions found" };
    }

    base.source_file = recent.file;
    base.source_mtime = recent.mtime.toISOString();

    const payload = await findLastTokenCountEvent(recent.file);
    if (!payload) {
      return { ...base, note: "no rate_limits data in most recent session yet" };
    }

    const rl = payload.rate_limits || {};
    return {
      ...base,
      primary: rl.primary
        ? {
            used_percent: rl.primary.used_percent,
            window_minutes: rl.primary.window_minutes,
            resets_at: rl.primary.resets_at,
          }
        : null,
      secondary: rl.secondary
        ? {
            used_percent: rl.secondary.used_percent,
            window_minutes: rl.secondary.window_minutes,
            resets_at: rl.secondary.resets_at,
          }
        : null,
      plan_type: rl.plan_type ?? null,
    };
  } catch (err) {
    return { ...base, note: `error: ${err?.message || String(err)}` };
  }
}

// Normalizes account/rateLimits/read's camelCase result into the same
// snake_case shape the rollout-tail fallback (and the menu bar app's
// Codable structs) already expect.
function normalizeRpcResult(result) {
  const rl = result?.rateLimits || {};
  const toWindow = (w) =>
    w ? { used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt } : null;

  return {
    captured_at: new Date().toISOString(),
    primary: toWindow(rl.primary),
    secondary: toWindow(rl.secondary),
    plan_type: rl.planType ?? null,
    source_file: null,
    source_mtime: null,
    source: "app_server_rpc",
  };
}

export async function getCodexLiveLimits() {
  try {
    const result = await getCodexLiveLimitsFromRpc();
    return normalizeRpcResult(result);
  } catch (err) {
    const fallback = await getCodexLiveLimitsFromRollout();
    return { ...fallback, note: `rpc_failed: ${err?.message || String(err)}${fallback.note ? `; ${fallback.note}` : ""}` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getCodexLiveLimits().then((r) => console.log(JSON.stringify(r, null, 2)));
}
