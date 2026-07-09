#!/usr/bin/env node
/**
 * Simple server for the Claude Code Usage Dashboard.
 * Serves static files + an API to read session JSONL logs.
 *
 * Usage: node server.mjs [port]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodexLiveLimits } from "./codex-live-limits.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const PORT = parseInt(process.argv[2] || "8484", 10);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

async function handleSessionLog(filePath) {
  // Only allow reading .jsonl files under ~/.claude
  if (!filePath.endsWith(".jsonl") || !filePath.includes(".claude/projects")) {
    return { status: 403, body: JSON.stringify({ error: "forbidden" }) };
  }

  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return { status: 404, body: JSON.stringify({ error: "not found" }) };
  }

  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        let text = "";
        if (typeof entry.message === "string") text = entry.message;
        else if (entry.message?.content) {
          if (typeof entry.message.content === "string") text = entry.message.content;
          else if (Array.isArray(entry.message.content)) {
            text = entry.message.content.map(c => {
              if (c.type === "text") return c.text;
              if (c.type === "tool_result") {
                const inner = typeof c.content === "string" ? c.content : (c.content || []).map(x => x.text || "").join(" ");
                return "[tool_result] " + inner.slice(0, 200);
              }
              return "[" + c.type + "]";
            }).join(" ");
          }
        }
        entries.push({ type: "user", content: text.slice(0, 500) });
      } else if (entry.type === "assistant" && entry.message?.content) {
        const parts = entry.message.content;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              entries.push({ type: "assistant", content: p.text.slice(0, 500) });
            } else if (p.type === "tool_use") {
              entries.push({ type: "tool", name: p.name, content: JSON.stringify(p.input).slice(0, 300) });
            }
          }
        }
      } else if (entry.type === "system") {
        entries.push({ type: "system", content: (entry.content || entry.subtype || "").toString().slice(0, 200) });
      }
    } catch { /* skip */ }
  }

  return { status: 200, body: JSON.stringify(entries) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // API endpoint
  if (url.pathname === "/api/session-log") {
    const filePath = url.searchParams.get("file");
    const result = await handleSessionLog(filePath);
    res.writeHead(result.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(result.body);
    return;
  }

  if (url.pathname === "/api/codex-live-limits") {
    try {
      const limits = await getCodexLiveLimits();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(limits));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
    return;
  }

  // Static files
  let filepath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = join(DIR, filepath);

  // Don't serve files outside DIR
  if (!fullPath.startsWith(DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
