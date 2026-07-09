#!/usr/bin/env node
/**
 * Parses all Codex CLI rollout JSONL logs and produces aggregated usage data.
 * Output: codex-usage-data.json
 *
 * Read-only w.r.t. ~/.codex/** at all times. The sqlite DB is copied to a
 * temp file before being opened, and the temp copy is deleted afterward.
 */

import { readdir, readFile, stat, writeFile, copyFile, unlink } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { writeLiveSnapshot } from "./codex-live-limits.mjs";

const HOME = homedir();
const SESSIONS_DIRS = [
  join(HOME, ".codex", "sessions"),
  join(HOME, ".codex", "archived_sessions"),
];
const SQLITE_PATH = join(HOME, ".codex", "state_5.sqlite");

async function* walkJsonl(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) yield full;
  }
}

// Copied verbatim from parse-logs.mjs so week-numbering is consistent
// between the two dashboards.
function getWeek(d) {
  const date = new Date(d);
  const jan1 = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - jan1) / 86400000);
  return `${date.getFullYear()}-W${String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, "0")}`;
}

async function loadThreadsMap() {
  const map = new Map();
  let tmpPath = null;
  try {
    const st = await stat(SQLITE_PATH).catch(() => null);
    if (!st) return map;

    tmpPath = join(tmpdir(), `codex-state-${process.pid}-${Date.now()}.sqlite`);
    await copyFile(SQLITE_PATH, tmpPath);

    const db = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, cwd, title, git_branch, model FROM threads").all();
      for (const row of rows) {
        map.set(row.id, row);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`  WARN: failed to read state_5.sqlite: ${err?.message || err}`);
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
  return map;
}

async function main() {
  const emptyUsage = () => ({
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });

  const addUsage = (target, usage) => {
    target.input_tokens += usage.input_tokens || 0;
    target.cached_input_tokens += usage.cached_input_tokens || 0;
    target.output_tokens += usage.output_tokens || 0;
    target.reasoning_output_tokens += usage.reasoning_output_tokens || 0;
    target.total_tokens += usage.total_tokens || 0;
  };

  console.log("Scanning Codex session logs...");
  const threadsMap = await loadThreadsMap();
  console.log(`  Loaded ${threadsMap.size} threads from state_5.sqlite`);

  const sessions = [];
  const modelTotals = {};
  const projectTotals = {};
  const dailyTotals = {};
  const weeklyTotals = {};
  const monthlyTotals = {};

  let totalFiles = 0;
  let filesSkippedNoUsage = 0;
  let parseErrors = 0;

  for (const sessionsDir of SESSIONS_DIRS) {
    console.log(`  Scanning ${sessionsDir}`);

    for await (const filePath of walkJsonl(sessionsDir)) {
      totalFiles++;
      if (totalFiles % 100 === 0) process.stderr.write(`  processed ${totalFiles} files...\n`);

      let content;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      let sessionId = null;
      let cwd = null;
      let sessionStart = null;
      let lastModel = null;
      let lastUsage = null;

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          parseErrors++;
          continue;
        }

        if (entry.type === "session_meta") {
          sessionId = entry.payload?.session_id || entry.payload?.id || sessionId;
          cwd = entry.payload?.cwd || cwd;
          sessionStart = entry.timestamp || entry.payload?.timestamp || sessionStart;
        } else if (entry.type === "turn_context") {
          if (entry.payload?.model) lastModel = entry.payload.model;
          if (entry.payload?.cwd && !cwd) cwd = entry.payload.cwd;
        } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
          const info = entry.payload.info;
          if (info?.total_token_usage) lastUsage = info.total_token_usage;
        }
      }

      if (!lastUsage) {
        filesSkippedNoUsage++;
        continue;
      }

      const st = await stat(filePath).catch(() => null);
      const sessionEnd = st ? st.mtime.toISOString() : null;

      const project = cwd ? basename(cwd) : "unknown";
      const model = lastModel || "unknown";
      const thread = sessionId ? threadsMap.get(sessionId) : null;
      const title = thread?.title || null;
      const gitBranch = thread?.git_branch || null;

      const tokens = {
        input_tokens: lastUsage.input_tokens || 0,
        cached_input_tokens: lastUsage.cached_input_tokens || 0,
        output_tokens: lastUsage.output_tokens || 0,
        reasoning_output_tokens: lastUsage.reasoning_output_tokens || 0,
        total_tokens: lastUsage.total_tokens || 0,
      };

      sessions.push({
        sessionId,
        file: filePath,
        cwd,
        project,
        model,
        title,
        gitBranch,
        start: sessionStart,
        end: sessionEnd,
        tokens,
      });

      // Model totals
      if (!modelTotals[model]) modelTotals[model] = { ...emptyUsage(), sessions: new Set() };
      addUsage(modelTotals[model], tokens);
      modelTotals[model].sessions.add(sessionId || filePath);

      // Project totals
      if (!projectTotals[project]) projectTotals[project] = { ...emptyUsage(), sessions: new Set() };
      addUsage(projectTotals[project], tokens);
      projectTotals[project].sessions.add(sessionId || filePath);

      // Time-based totals — keyed off session START date
      if (sessionStart) {
        const day = sessionStart.slice(0, 10);
        const month = sessionStart.slice(0, 7);
        const week = getWeek(sessionStart);

        if (!dailyTotals[day]) dailyTotals[day] = { ...emptyUsage(), sessions: new Set() };
        addUsage(dailyTotals[day], tokens);
        dailyTotals[day].sessions.add(sessionId || filePath);

        if (!weeklyTotals[week]) weeklyTotals[week] = { ...emptyUsage(), sessions: new Set() };
        addUsage(weeklyTotals[week], tokens);
        weeklyTotals[week].sessions.add(sessionId || filePath);

        if (!monthlyTotals[month]) monthlyTotals[month] = { ...emptyUsage(), sessions: new Set() };
        addUsage(monthlyTotals[month], tokens);
        monthlyTotals[month].sessions.add(sessionId || filePath);
      }
    }
  }

  // Convert session Sets to counts
  for (const bucketGroup of [modelTotals, projectTotals, dailyTotals, weeklyTotals, monthlyTotals]) {
    for (const bucket of Object.values(bucketGroup)) {
      bucket.sessions = bucket.sessions.size;
    }
  }

  const totalTokens = sessions.reduce((sum, s) => sum + (s.tokens.total_tokens || 0), 0);

  const data = {
    generated: new Date().toISOString(),
    summary: {
      totalFiles,
      totalSessions: sessions.length,
      filesSkippedNoUsage,
      totalTokens,
      dateRange: {
        earliest: sessions.reduce((min, s) => (!min || (s.start && s.start < min) ? s.start : min), null),
        latest: sessions.reduce((max, s) => (!max || (s.end && s.end > max) ? s.end : max), null),
      },
    },
    byModel: modelTotals,
    byProject: projectTotals,
    byDay: dailyTotals,
    byWeek: weeklyTotals,
    byMonth: monthlyTotals,
    sessions: sessions.sort((a, b) => (b.end || "").localeCompare(a.end || "")),
  };

  const outPath = join(dirname(new URL(import.meta.url).pathname), "codex-usage-data.json");
  await writeFile(outPath, JSON.stringify(data, null, 2));

  console.log(`\nDone! Parsed ${totalFiles} files, ${sessions.length} sessions with usage data.`);
  console.log(`Files skipped (no usage data): ${filesSkippedNoUsage}`);
  console.log(`Parse errors: ${parseErrors}`);
  console.log(`Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`Output: ${outPath}`);

  // Write live rate-limit snapshot, atomically.
  try {
    await writeLiveSnapshot();
    console.log(`Rate limits: ${join(dirname(new URL(import.meta.url).pathname), "codex-rate-limits.json")}`);
  } catch (err) {
    console.error(`  WARN: failed to write codex-rate-limits.json: ${err?.message || err}`);
  }
}

main().catch(console.error);
