#!/usr/bin/env node
/**
 * Parses all Claude Code session JSONL logs and produces aggregated usage data.
 * Output: usage-data.json
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";

// Sources: local logs + any remote mirrors under ~/.claude/remote-logs/
const HOME = process.env.HOME;
const SOURCES = [
  { dir: join(HOME, ".claude", "projects"), device: "MacBook Pro" },
  { dir: join(HOME, ".claude", "remote-logs", "mac-mini"), device: "Mac Mini" },
];

async function* walkJsonl(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.name.endsWith(".jsonl")) yield full;
  }
}

function projectFromPath(filePath, sourceDir) {
  const rel = filePath.replace(sourceDir + "/", "");
  const topDir = rel.split("/")[0];
  const parts = topDir.replace(/^-/, "").split("-");

  // Try to find a project name — look for common patterns
  // -Users-christaylor-Projects-chris-assistant -> chris-assistant
  // -Users-office-Projects-foo -> foo
  // -Users-christaylor-claude-Cron -> Cron
  // -Users-christaylor -> ~ (home dir)
  const usersIdx = parts.indexOf("Users");
  if (usersIdx >= 0 && parts[usersIdx + 2] === "Projects" && parts[usersIdx + 3]) {
    return parts.slice(usersIdx + 3).join("-");
  }
  if (usersIdx >= 0 && parts.length > usersIdx + 2) {
    return parts.slice(usersIdx + 2).join("-");
  }
  return topDir || "unknown";
}

function getWeek(d) {
  const date = new Date(d);
  const jan1 = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - jan1) / 86400000);
  return `${date.getFullYear()}-W${String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, "0")}`;
}

async function main() {
  const sessions = [];
  const modelTotals = {};
  const projectTotals = {};
  const dailyTotals = {};
  const weeklyTotals = {};
  const monthlyTotals = {};

  let totalFiles = 0;
  let totalMessages = 0;
  let parseErrors = 0;

  const emptyUsage = () => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });

  const addUsage = (target, usage) => {
    target.input_tokens += usage.input_tokens || 0;
    target.output_tokens += usage.output_tokens || 0;
    target.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
    target.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  };

  // Pricing per million tokens (approximate, varies by model)
  const pricing = {
    "claude-opus-4-6": { input: 15, output: 75, cache_create: 18.75, cache_read: 1.5 },
    "claude-opus-4-20250918": { input: 15, output: 75, cache_create: 18.75, cache_read: 1.5 },
    "claude-sonnet-4-6": { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 },
    "claude-sonnet-4-20250514": { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 },
    "claude-3-7-sonnet-20250219": { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 },
    "claude-3-5-sonnet-20241022": { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cache_create: 1, cache_read: 0.08 },
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cache_create: 1, cache_read: 0.08 },
  };

  function estimateCost(model, usage) {
    // Find pricing — try exact match, then prefix match
    let p = pricing[model];
    if (!p) {
      if (model?.includes("opus")) p = pricing["claude-opus-4-6"];
      else if (model?.includes("haiku")) p = pricing["claude-haiku-4-5-20251001"];
      else if (model?.includes("sonnet")) p = pricing["claude-sonnet-4-6"];
      else p = { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 }; // default to sonnet
    }
    return (
      ((usage.input_tokens || 0) * p.input +
        (usage.output_tokens || 0) * p.output +
        (usage.cache_creation_input_tokens || 0) * p.cache_create +
        (usage.cache_read_input_tokens || 0) * p.cache_read) /
      1_000_000
    );
  }

  const deviceTotals = {};

  console.log("Scanning session logs...");

  for (const source of SOURCES) {
    console.log(`  Scanning ${source.device}: ${source.dir}`);
    if (!deviceTotals[source.device]) deviceTotals[source.device] = { ...emptyUsage(), messages: 0, sessions: 0, cost: 0 };

    for await (const filePath of walkJsonl(source.dir)) {
    totalFiles++;
    if (totalFiles % 500 === 0) process.stderr.write(`  processed ${totalFiles} files...\n`);

    const device = source.device;
    const project = projectFromPath(filePath, source.dir);
    const sessionId = basename(dirname(filePath)).replace(/^subagents$/, basename(dirname(dirname(filePath))));
    const isSubagent = filePath.includes("/subagents/");

    let content;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const sessionUsage = emptyUsage();
    let sessionModel = null;
    let sessionStart = null;
    let sessionEnd = null;
    let messageCount = 0;
    let version = null;
    const modelsUsed = new Set();

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }

      if (entry.version && !version) version = entry.version;

      const ts = entry.timestamp;
      if (ts) {
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }

      // Extract usage from assistant messages
      if (entry.type === "assistant" && entry.message?.usage) {
        const usage = entry.message.usage;
        const model = entry.message.model || "unknown";
        modelsUsed.add(model);
        if (!sessionModel) sessionModel = model;
        messageCount++;
        totalMessages++;

        addUsage(sessionUsage, usage);

        // Model totals
        if (!modelTotals[model]) modelTotals[model] = { ...emptyUsage(), messages: 0, cost: 0 };
        addUsage(modelTotals[model], usage);
        modelTotals[model].messages++;
        modelTotals[model].cost += estimateCost(model, usage);

        // Device totals
        addUsage(deviceTotals[device], usage);
        deviceTotals[device].messages++;
        deviceTotals[device].cost += estimateCost(model, usage);

        // Project totals
        if (!projectTotals[project]) projectTotals[project] = { ...emptyUsage(), messages: 0, sessions: new Set(), cost: 0 };
        addUsage(projectTotals[project], usage);
        projectTotals[project].messages++;
        projectTotals[project].sessions.add(sessionId);
        projectTotals[project].cost += estimateCost(model, usage);

        // Time-based totals
        if (ts) {
          const day = ts.slice(0, 10);
          const month = ts.slice(0, 7);
          const week = getWeek(ts);

          if (!dailyTotals[day]) dailyTotals[day] = { ...emptyUsage(), messages: 0, cost: 0 };
          addUsage(dailyTotals[day], usage);
          dailyTotals[day].messages++;
          dailyTotals[day].cost += estimateCost(model, usage);

          if (!weeklyTotals[week]) weeklyTotals[week] = { ...emptyUsage(), messages: 0, cost: 0 };
          addUsage(weeklyTotals[week], usage);
          weeklyTotals[week].messages++;
          weeklyTotals[week].cost += estimateCost(model, usage);

          if (!monthlyTotals[month]) monthlyTotals[month] = { ...emptyUsage(), messages: 0, cost: 0 };
          addUsage(monthlyTotals[month], usage);
          monthlyTotals[month].messages++;
          monthlyTotals[month].cost += estimateCost(model, usage);
        }
      }
    }

    if (messageCount > 0) {
      deviceTotals[device].sessions++;
      sessions.push({
        sessionId,
        file: filePath,
        device,
        project,
        model: sessionModel,
        modelsUsed: [...modelsUsed],
        isSubagent,
        version,
        start: sessionStart,
        end: sessionEnd,
        messages: messageCount,
        usage: sessionUsage,
        cost: estimateCost(sessionModel, sessionUsage),
      });
    }
  } // end walkJsonl loop
  } // end SOURCES loop

  // Convert project session sets to counts
  for (const p of Object.values(projectTotals)) {
    p.sessions = p.sessions.size;
  }

  const data = {
    generated: new Date().toISOString(),
    summary: {
      totalFiles,
      totalSessions: sessions.length,
      totalMessages,
      parseErrors,
      totalUsage: sessions.reduce(
        (acc, s) => {
          addUsage(acc, s.usage);
          return acc;
        },
        emptyUsage()
      ),
      totalCost: sessions.reduce((sum, s) => sum + s.cost, 0),
      dateRange: {
        earliest: sessions.reduce((min, s) => (!min || s.start < min ? s.start : min), null),
        latest: sessions.reduce((max, s) => (!max || s.end > max ? s.end : max), null),
      },
    },
    byModel: modelTotals,
    byDevice: deviceTotals,
    byProject: projectTotals,
    byDay: dailyTotals,
    byWeek: weeklyTotals,
    byMonth: monthlyTotals,
    sessions: sessions.sort((a, b) => (b.start || "").localeCompare(a.start || "")),
  };

  const outPath = join(dirname(new URL(import.meta.url).pathname), "usage-data.json");
  await writeFile(outPath, JSON.stringify(data, null, 2));
  console.log(`\nDone! Parsed ${totalFiles} files, ${sessions.length} sessions with usage data, ${totalMessages} messages.`);
  console.log(`Parse errors: ${parseErrors}`);
  console.log(`Output: ${outPath}`);
  console.log(`Estimated total cost: $${data.summary.totalCost.toFixed(2)}`);
}

main().catch(console.error);
