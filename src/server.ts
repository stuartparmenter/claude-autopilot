import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { AppState } from "./state";

export function createApp(state: AppState): Hono {
  const app = new Hono();

  // --- HTML Shell ---
  app.get("/", (c) => {
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <title>claude-autopilot</title>
            <script src="https://unpkg.com/htmx.org@2.0.4"></script>
            <style>
              *,
              *::before,
              *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
              }
              :root {
                --bg: #0d1117;
                --bg-surface: #161b22;
                --bg-card: #1c2128;
                --border: #30363d;
                --text: #e6edf3;
                --text-dim: #8b949e;
                --accent: #58a6ff;
                --green: #3fb950;
                --red: #f85149;
                --yellow: #d29922;
                --purple: #bc8cff;
              }
              body {
                font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
                font-size: 13px;
                background: var(--bg);
                color: var(--text);
                height: 100vh;
                display: flex;
                flex-direction: column;
              }
              header {
                background: var(--bg-surface);
                border-bottom: 1px solid var(--border);
                padding: 12px 20px;
                display: flex;
                align-items: center;
                gap: 16px;
              }
              header h1 {
                font-size: 14px;
                font-weight: 600;
              }
              header .meta {
                color: var(--text-dim);
                font-size: 12px;
              }
              .layout {
                display: flex;
                flex: 1;
                overflow: hidden;
              }
              .sidebar {
                width: 320px;
                min-width: 320px;
                border-right: 1px solid var(--border);
                overflow-y: auto;
                background: var(--bg-surface);
              }
              .main {
                flex: 1;
                overflow-y: auto;
                padding: 16px 20px;
              }
              .section-title {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--text-dim);
                padding: 12px 16px 6px;
              }
              .agent-card {
                display: block;
                padding: 10px 16px;
                border-bottom: 1px solid var(--border);
                cursor: pointer;
                text-decoration: none;
                color: inherit;
              }
              .agent-card:hover {
                background: var(--bg-card);
              }
              .agent-card.selected {
                background: var(--bg-card);
                border-left: 2px solid var(--accent);
                padding-left: 14px;
              }
              .agent-card .issue-id {
                color: var(--accent);
                font-weight: 600;
                font-size: 12px;
              }
              .agent-card .title {
                font-size: 12px;
                color: var(--text);
                margin-top: 2px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .agent-card .meta {
                font-size: 11px;
                color: var(--text-dim);
                margin-top: 3px;
              }
              .status-dot {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                margin-right: 4px;
              }
              .status-dot.running {
                background: var(--green);
                animation: pulse 2s infinite;
              }
              .status-dot.completed {
                background: var(--green);
              }
              .status-dot.failed {
                background: var(--red);
              }
              .status-dot.timed_out {
                background: var(--yellow);
              }
              @keyframes pulse {
                0%,
                100% {
                  opacity: 1;
                }
                50% {
                  opacity: 0.4;
                }
              }
              .activity-item {
                padding: 6px 0;
                border-bottom: 1px solid var(--border);
                font-size: 12px;
                word-break: break-word;
                overflow-wrap: anywhere;
              }
              .activity-item .time {
                color: var(--text-dim);
                font-size: 11px;
              }
              .activity-item .type-badge {
                display: inline-block;
                font-size: 10px;
                padding: 1px 5px;
                border-radius: 3px;
                margin: 0 4px;
              }
              .type-badge.tool_use {
                background: #1f3a5f;
                color: var(--accent);
              }
              .type-badge.text {
                background: #2a1f3f;
                color: var(--purple);
              }
              .type-badge.result {
                background: #1a3a1a;
                color: var(--green);
              }
              .type-badge.error {
                background: #3f1f1f;
                color: var(--red);
              }
              .type-badge.status {
                background: #3a2f1a;
                color: var(--yellow);
              }
              .empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: var(--text-dim);
              }
              .empty-state .icon {
                font-size: 32px;
                margin-bottom: 12px;
              }
              .stats-bar {
                display: flex;
                gap: 20px;
                margin-left: auto;
              }
              .stat {
                text-align: center;
              }
              .stat .value {
                font-weight: 600;
                font-size: 16px;
              }
              .stat .label {
                font-size: 10px;
                color: var(--text-dim);
                text-transform: uppercase;
              }
              .detail-text {
                margin-top: 4px;
                padding: 8px 10px;
                background: var(--bg);
                border-left: 2px solid var(--border);
                border-radius: 0 4px 4px 0;
                font-size: 11px;
                color: var(--text-dim);
                white-space: pre-wrap;
                word-break: break-word;
              }
              .history-card {
                padding: 8px 16px;
                border-bottom: 1px solid var(--border);
                font-size: 12px;
              }
              .history-card .issue-id {
                font-weight: 600;
                font-size: 11px;
              }
              .history-card .title {
                color: var(--text-dim);
                font-size: 11px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .pause-btn {
                padding: 4px 12px;
                border-radius: 4px;
                border: 1px solid var(--border);
                background: var(--bg-card);
                color: var(--text);
                font-family: inherit;
                font-size: 12px;
                cursor: pointer;
              }
              .pause-btn:hover {
                background: var(--border);
              }
              .pause-btn.paused {
                background: var(--yellow);
                color: var(--bg);
                border-color: var(--yellow);
              }
              .auditor-badge {
                display: inline-block;
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 3px;
                background: #2a1f3f;
                color: var(--purple);
                margin-left: 8px;
              }
            </style>
          </head>
          <body>
            <header>
              <h1>claude-autopilot</h1>
              <div
                class="meta"
                hx-get="/partials/header-meta"
                hx-trigger="every 5s"
                hx-swap="innerHTML"
              >
                Loading...
              </div>
              <div
                id="pause-btn"
                hx-get="/partials/pause-button"
                hx-trigger="load, every 5s"
                hx-swap="innerHTML"
              ></div>
              <div
                class="stats-bar"
                hx-get="/partials/stats"
                hx-trigger="every 5s"
                hx-swap="innerHTML"
              ></div>
            </header>
            <div class="layout">
              <div class="sidebar">
                <div class="section-title">Running Agents</div>
                <div
                  id="agents-list"
                  hx-get="/partials/agents"
                  hx-trigger="load, every 3s"
                  hx-swap="innerHTML"
                ></div>
                <div class="section-title">History</div>
                <div
                  id="history-list"
                  hx-get="/partials/history"
                  hx-trigger="load, every 10s"
                  hx-swap="innerHTML"
                ></div>
              </div>
              <div class="main" id="main-panel">
                <div class="empty-state">
                  <div class="icon">~</div>
                  <div>Select an agent to view live activity</div>
                  <div style="margin-top: 8px; font-size: 11px">
                    Waiting for agents to start...
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>`,
    );
  });

  // --- JSON API ---
  app.get("/api/status", (c) => {
    return c.json(state.toJSON());
  });

  app.post("/api/pause", (c) => {
    const paused = state.togglePause();
    return c.json({ paused });
  });

  // --- Partials for htmx ---

  app.get("/partials/pause-button", (c) => {
    const paused = state.isPaused();
    return c.html(
      html`<button
        class="pause-btn ${paused ? "paused" : ""}"
        hx-post="/api/pause"
        hx-target="#pause-btn"
        hx-swap="innerHTML"
        hx-select="button"
      >
        ${paused ? "Paused" : "Pause"}
      </button>`,
    );
  });

  app.get("/partials/header-meta", (c) => {
    const uptime = Math.round((Date.now() - state.startedAt) / 1000);
    return c.html(html`Uptime: ${formatDuration(uptime)}`);
  });

  app.get("/partials/stats", (c) => {
    const snap = state.toJSON();
    return c.html(html`
      <div class="stat">
        <div class="value">${String(snap.agents.length)}</div>
        <div class="label">Running</div>
      </div>
      <div class="stat">
        <div class="value">${String(snap.queue.readyCount)}</div>
        <div class="label">Ready</div>
      </div>
      <div class="stat">
        <div class="value">
          ${String(snap.history.filter((h) => h.status === "completed").length)}
        </div>
        <div class="label">Done</div>
      </div>
      <div class="stat">
        <div class="value">
          ${String(snap.history.filter((h) => h.status !== "completed").length)}
        </div>
        <div class="label">Failed</div>
      </div>
    `);
  });

  app.get("/partials/agents", (c) => {
    const agents = state.getRunningAgents();
    if (agents.length === 0) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          No agents running
        </div>`,
      );
    }
    return c.html(
      html`${raw(
        agents
          .map((a) => {
            const elapsed = Math.round((Date.now() - a.startedAt) / 1000);
            const elapsedStr =
              elapsed > 60 ? `${Math.floor(elapsed / 60)}m` : `${elapsed}s`;
            return `<div class="agent-card" hx-get="/partials/activity/${a.id}" hx-target="#main-panel" hx-swap="innerHTML">
            <div><span class="status-dot running"></span><span class="issue-id">${escapeHtml(a.issueId)}</span></div>
            <div class="title">${escapeHtml(a.issueTitle)}</div>
            <div class="meta">${elapsedStr} &middot; ${a.activities.length} activities</div>
          </div>`;
          })
          .join(""),
      )}`,
    );
  });

  app.get("/partials/activity/:id", (c) => {
    const id = c.req.param("id");
    const verbose = c.req.query("verbose") === "true";
    const agent = state.getAgent(id);

    if (!agent) {
      // Check history
      const hist = state.getHistory().find((h) => h.id === id);
      if (hist) {
        const durationStr = hist.durationMs
          ? `${Math.round(hist.durationMs / 1000)}s`
          : "?";
        const costStr = hist.costUsd ? `$${hist.costUsd.toFixed(4)}` : "";
        return c.html(html`
          <div style="padding: 8px 0">
            <div>
              <span class="status-dot ${hist.status}"></span>
              <strong>${hist.issueId}</strong> — ${hist.issueTitle}
            </div>
            <div class="meta" style="margin-top: 6px">
              Status: ${hist.status} &middot; Duration: ${durationStr}
              ${costStr ? html` &middot; Cost: ${costStr}` : ""}
              ${hist.error ? html` &middot; Error: ${hist.error}` : ""}
            </div>
          </div>
        `);
      }
      return c.html(html`<div class="empty-state">Agent not found</div>`);
    }

    const elapsed = Math.round((Date.now() - agent.startedAt) / 1000);
    const elapsedStr =
      elapsed > 60
        ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
        : `${elapsed}s`;

    const activities = verbose ? agent.activities : agent.activities.slice(-50);

    return c.html(html`
      <div
        id="activity-view"
        hx-get="/partials/activity/${id}${verbose ? "?verbose=true" : ""}"
        hx-trigger="every 3s"
        hx-swap="outerHTML"
      >
        <div style="display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border)">
          <div>
            <span class="status-dot ${agent.status}"></span>
            <strong>${agent.issueId}</strong> — ${agent.issueTitle}
          </div>
          <div class="meta">${elapsedStr} &middot; ${String(agent.activities.length)} activities</div>
          ${!verbose ? html`<a href="#" hx-get="/partials/activity/${id}?verbose=true" hx-target="#main-panel" hx-swap="innerHTML" style="color: var(--accent); font-size: 11px; margin-left: auto">verbose</a>` : html`<a href="#" hx-get="/partials/activity/${id}" hx-target="#main-panel" hx-swap="innerHTML" style="color: var(--accent); font-size: 11px; margin-left: auto">compact</a>`}
        </div>
        ${raw(
          activities
            .map((act) => {
              const time = new Date(act.timestamp).toLocaleTimeString("en-US", {
                hour12: false,
              });
              const detailHtml =
                verbose && act.detail
                  ? `<div class="detail-text">${escapeHtml(act.detail)}</div>`
                  : "";
              return `<div class="activity-item">
                <span class="time">${time}</span>
                <span class="type-badge ${act.type}">${act.type}</span>
                ${escapeHtml(act.summary)}
                ${detailHtml}
              </div>`;
            })
            .join(""),
        )}
      </div>
    `);
  });

  app.get("/partials/history", (c) => {
    const history = state.getHistory();
    if (history.length === 0) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          No completed agents yet
        </div>`,
      );
    }
    return c.html(
      html`${raw(
        history
          .slice(0, 20)
          .map((h) => {
            const durationStr = h.durationMs
              ? `${Math.round(h.durationMs / 1000)}s`
              : "";
            const costStr = h.costUsd ? `$${h.costUsd.toFixed(4)}` : "";
            return `<div class="history-card" hx-get="/partials/activity/${h.id}" hx-target="#main-panel" hx-swap="innerHTML" style="cursor:pointer">
            <div><span class="status-dot ${h.status}"></span><span class="issue-id">${escapeHtml(h.issueId)}</span> ${durationStr} ${costStr}</div>
            <div class="title">${escapeHtml(h.issueTitle)}</div>
          </div>`;
          })
          .join(""),
      )}`,
    );
  });

  return app;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
