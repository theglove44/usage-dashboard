/**
 * Live Quotas panel — shared between index.html and codex.html.
 * Fetches claude-rate-limits.json (static) and /api/codex-live-limits (dynamic),
 * renders side-by-side progress bars for Claude and Codex usage windows.
 * Zero dependencies, defensive against missing/404/null data.
 */
(function () {
  "use strict";

  var RESET_TICK_MS = 45000; // recompute countdown text every 45s
  var resetTargets = []; // [{ el, resetsAt }]
  var tickHandle = null;

  function injectStyles() {
    if (document.getElementById("lq-styles")) return;
    var style = document.createElement("style");
    style.id = "lq-styles";
    style.textContent =
      ".lq-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }" +
      "@media (max-width: 720px) { .lq-panel { grid-template-columns: 1fr; } }" +
      ".lq-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }" +
      ".lq-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; color: var(--text-dim); display: flex; align-items: center; justify-content: space-between; }" +
      ".lq-card h3 .lq-meta { font-size: 11px; font-weight: 500; color: var(--text-dim); text-transform: none; letter-spacing: 0; }" +
      ".lq-window { margin-bottom: 14px; }" +
      ".lq-window:last-child { margin-bottom: 0; }" +
      ".lq-window-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; font-size: 12px; }" +
      ".lq-window-label { color: var(--text); font-weight: 500; }" +
      ".lq-window-pct { font-variant-numeric: tabular-nums; font-weight: 600; }" +
      ".lq-window-reset { color: var(--text-dim); font-size: 11px; }" +
      ".lq-bar-track { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; height: 10px; overflow: hidden; }" +
      ".lq-bar-fill { height: 100%; border-radius: 5px 0 0 5px; transition: width 0.3s ease; }" +
      ".lq-bar-fill.lq-green { background: var(--green); }" +
      ".lq-bar-fill.lq-amber { background: var(--amber); }" +
      ".lq-bar-fill.lq-red { background: var(--red); }" +
      ".lq-empty { color: var(--text-dim); font-size: 12px; font-style: italic; padding: 6px 0; }" +
      ".lq-unavailable { color: var(--text-dim); font-size: 13px; padding: 20px 0; text-align: center; }" +
      ".lq-extra { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11px; color: var(--text-dim); }" +
      ".lq-extra span strong { color: var(--text); font-weight: 600; }";
    document.head.appendChild(style);
  }

  function barClass(pct) {
    if (pct >= 85) return "lq-red";
    if (pct >= 60) return "lq-amber";
    return "lq-green";
  }

  function fmtCountdown(resetsAt) {
    if (resetsAt === null || resetsAt === undefined) return "";
    var nowSec = Date.now() / 1000;
    var diff = resetsAt - nowSec;
    if (diff <= 0) return "resetting now";
    var totalMin = Math.round(diff / 60);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h <= 0) return "resets in " + m + "m";
    return "resets in " + h + "h " + m + "m";
  }

  function windowHtml(label, windowData) {
    if (!windowData || windowData.used_percentage == null && windowData.used_percent == null) {
      return '<div class="lq-window">' +
        '<div class="lq-window-head"><span class="lq-window-label">' + label + '</span></div>' +
        '<div class="lq-empty">no data yet</div>' +
        '</div>';
    }
    var pct = windowData.used_percentage != null ? windowData.used_percentage : windowData.used_percent;
    pct = Math.max(0, Math.min(100, Number(pct)));
    var cls = barClass(pct);
    var resetsAt = windowData.resets_at;
    var resetId = "lq-reset-" + Math.random().toString(36).slice(2);

    if (resetsAt !== null && resetsAt !== undefined) {
      resetTargets.push({ id: resetId, resetsAt: resetsAt });
    }

    return '<div class="lq-window">' +
      '<div class="lq-window-head">' +
        '<span class="lq-window-label">' + label + '</span>' +
        '<span class="lq-window-pct">' + pct + '%</span>' +
      '</div>' +
      '<div class="lq-bar-track"><div class="lq-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '<div class="lq-window-reset" id="' + resetId + '">' +
        (resetsAt != null ? fmtCountdown(resetsAt) : "reset time unknown") +
      '</div>' +
      '</div>';
  }

  function fmtCapturedAt(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function renderClaudeCard(data) {
    if (!data) {
      return '<div class="lq-card"><h3>Claude</h3><div class="lq-unavailable">unavailable — no rate-limit snapshot found</div></div>';
    }
    var extras = [];
    if (data.cost_usd != null) extras.push('<span>Cost: <strong>$' + Number(data.cost_usd).toFixed(2) + '</strong></span>');
    if (data.context_used_percentage != null) extras.push('<span>Context: <strong>' + data.context_used_percentage + '%</strong></span>');
    if (data.model) extras.push('<span>Model: <strong>' + data.model + '</strong></span>');

    return '<div class="lq-card">' +
      '<h3>Claude <span class="lq-meta">' + fmtCapturedAt(data.captured_at) + '</span></h3>' +
      windowHtml("5-hour", data.five_hour) +
      windowHtml("Weekly", data.seven_day) +
      (extras.length ? '<div class="lq-extra">' + extras.join("") + '</div>' : "") +
      '</div>';
  }

  function windowLabelFromMinutes(minutes) {
    if (minutes === 300) return "5-hour";
    if (minutes === 10080) return "weekly";
    if (minutes == null) return "window";
    // Fallback: derive a readable label for unexpected window sizes.
    if (minutes % 1440 === 0) return (minutes / 1440) + "-day";
    if (minutes % 60 === 0) return (minutes / 60) + "-hour";
    return minutes + "m";
  }

  function renderCodexCard(data) {
    if (!data) {
      return '<div class="lq-card"><h3>Codex</h3><div class="lq-unavailable">unavailable — no live limits data</div></div>';
    }
    var primaryLabel = data.primary ? windowLabelFromMinutes(data.primary.window_minutes) : "5-hour";
    var secondaryLabel = data.secondary ? windowLabelFromMinutes(data.secondary.window_minutes) : "weekly";

    var extras = [];
    if (data.plan_type) extras.push('<span>Plan: <strong>' + data.plan_type + '</strong></span>');

    return '<div class="lq-card">' +
      '<h3>Codex <span class="lq-meta">' + fmtCapturedAt(data.captured_at) + '</span></h3>' +
      windowHtml(capitalize(primaryLabel), data.primary) +
      windowHtml(capitalize(secondaryLabel), data.secondary) +
      (extras.length ? '<div class="lq-extra">' + extras.join("") + '</div>' : "") +
      '</div>';
  }

  function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function fetchJson(url) {
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function startTicker() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(tick, RESET_TICK_MS);
  }

  function tick() {
    resetTargets.forEach(function (t) {
      var el = document.getElementById(t.id);
      if (el) el.textContent = fmtCountdown(t.resetsAt);
    });
  }

  function render(container, claudeData, codexData) {
    resetTargets = [];
    container.innerHTML = '<div class="lq-panel">' +
      renderClaudeCard(claudeData) +
      renderCodexCard(codexData) +
      '</div>';
    tick();
    startTicker();
  }

  function init() {
    var container = document.getElementById("live-quotas");
    if (!container) return;
    injectStyles();
    container.innerHTML = '<div class="lq-panel"><div class="lq-card"><div class="lq-unavailable">loading…</div></div><div class="lq-card"><div class="lq-unavailable">loading…</div></div></div>';

    Promise.all([
      fetchJson("claude-rate-limits.json"),
      fetchJson("/api/codex-live-limits")
    ]).then(function (results) {
      render(container, results[0], results[1]);
    }).catch(function () {
      // Should not happen since fetchJson already swallows errors, but guard anyway.
      render(container, null, null);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
