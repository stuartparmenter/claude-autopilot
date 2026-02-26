import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { DASHBOARD_CSS } from "./dashboard-styles";
import type { AutopilotConfig } from "./lib/config";
import type { AppState } from "./state";

const ACTIVITY_SAYINGS = [
  "Working...",
  "Thinking...",
  "Still going...",
  "Processing...",
  "On it...",
  "Crunching...",
  "Making progress...",
  "Busy...",
  "Humming along...",
  "In the zone...",
];

function randomSaying(): string {
  return ACTIVITY_SAYINGS[Math.floor(Math.random() * ACTIVITY_SAYINGS.length)];
}

export interface DashboardOptions {
  authToken?: string;
  secureCookie?: boolean;
  triggerPlanning?: () => void;
  retryIssue?: (linearIssueId: string) => Promise<void>;
  config?: AutopilotConfig;
  triageIssues?: () => Promise<
    Array<{ id: string; identifier: string; title: string; priority: number }>
  >;
  approveTriageIssue?: (issueId: string) => Promise<void>;
  rejectTriageIssue?: (issueId: string) => Promise<void>;
}

export function safeCompare(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>autopilot</title>
    <style>
      ${DASHBOARD_CSS}
      .login-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        gap: 24px;
      }
      .login-form {
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 32px;
        width: 320px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .login-form label {
        font-size: 12px;
        color: var(--text-dim);
        display: block;
        margin-bottom: 4px;
      }
      .login-form input[type="password"] {
        width: 100%;
        padding: 8px 12px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
      }
      .login-form input[type="password"]:focus {
        outline: none;
        border-color: var(--accent);
      }
      .login-submit {
        padding: 8px 16px;
        background: var(--accent);
        border: none;
        border-radius: 4px;
        color: var(--bg);
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        width: 100%;
      }
      .login-error {
        color: var(--red);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="login-wrap">
      <h1>autopilot</h1>
      <form method="POST" action="/auth/login" class="login-form">
        <div>
          <label for="token">Dashboard Token</label>
          <input
            type="password"
            id="token"
            name="token"
            autofocus
            placeholder="Enter your token"
          />
        </div>
        ${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}
        <button type="submit" class="login-submit">Login</button>
      </form>
    </div>
  </body>
</html>`;
}

type HealthStatus = "pass" | "warn" | "fail";

export interface HealthResponse {
  status: HealthStatus;
  uptime: number;
  memory: { rss: number };
  subsystems: {
    executor: {
      status: HealthStatus;
      runningAgents: number;
      queueLastChecked: number | null;
    };
    monitor: { status: HealthStatus };
    planner: {
      status: HealthStatus;
      running: boolean;
      lastResult: string | null;
      lastRunAt: number | null;
    };
    projects: { status: HealthStatus };
  };
}

const QUEUE_WARN_MS = 5 * 60 * 1000;
const QUEUE_FAIL_MS = 10 * 60 * 1000;

export function computeHealth(
  state: AppState,
  now = Date.now(),
): HealthResponse {
  const snap = state.toJSON();
  const uptimeSeconds = Math.floor((now - state.startedAt) / 1000);
  const mem = process.memoryUsage();

  let executorStatus: HealthStatus = "pass";
  if (snap.queue.lastChecked > 0) {
    const queueAge = now - snap.queue.lastChecked;
    if (queueAge > QUEUE_FAIL_MS) {
      executorStatus = "fail";
    } else if (queueAge > QUEUE_WARN_MS) {
      executorStatus = "warn";
    }
  }

  const monitorStatus: HealthStatus = executorStatus;

  const plannerStatus: HealthStatus =
    snap.planning.lastResult === "failed" ||
    snap.planning.lastResult === "timed_out"
      ? "warn"
      : "pass";

  const projectsStatus: HealthStatus = "pass";

  const allStatuses: HealthStatus[] = [
    executorStatus,
    monitorStatus,
    plannerStatus,
    projectsStatus,
  ];
  let overallStatus: HealthStatus;
  if (allStatuses.includes("fail")) {
    overallStatus = "fail";
  } else if (allStatuses.includes("warn") || snap.paused) {
    overallStatus = "warn";
  } else {
    overallStatus = "pass";
  }

  return {
    status: overallStatus,
    uptime: uptimeSeconds,
    memory: { rss: mem.rss },
    subsystems: {
      executor: {
        status: executorStatus,
        runningAgents: state.getRunningCount(),
        queueLastChecked:
          snap.queue.lastChecked > 0 ? snap.queue.lastChecked : null,
      },
      monitor: {
        status: monitorStatus,
      },
      planner: {
        status: plannerStatus,
        running: snap.planning.running,
        lastResult: snap.planning.lastResult ?? null,
        lastRunAt: snap.planning.lastRunAt ?? null,
      },
      projects: {
        status: projectsStatus,
      },
    },
  };
}

export function createApp(state: AppState, options?: DashboardOptions): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  });

  if (options?.authToken) {
    const authToken = options.authToken;

    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/auth/") || c.req.path === "/health") {
        return next();
      }
      const authHeader = c.req.header("Authorization");
      const bearerToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      const cookieToken = getCookie(c, "autopilot_token") ?? null;
      const tokenToCheck = bearerToken ?? cookieToken;

      if (tokenToCheck !== null && safeCompare(tokenToCheck, authToken)) {
        // CSRF protection: cookie-authenticated POST requests must include a non-simple header
        const isCookieAuth = bearerToken === null && cookieToken !== null;
        if (isCookieAuth && c.req.method === "POST") {
          const hasHxRequest = c.req.header("HX-Request") === "true";
          const hasXRequestedWith =
            c.req.header("X-Requested-With") === "XMLHttpRequest";
          if (!hasHxRequest && !hasXRequestedWith) {
            return c.json({ error: "Forbidden" }, 403);
          }
        }
        return next();
      }

      if (
        c.req.path.startsWith("/api/") ||
        c.req.path.startsWith("/partials/")
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return c.html(loginPage(), 401);
    });

    app.post("/auth/login", async (c) => {
      const body = await c.req.parseBody();
      const submitted = String(body.token ?? "");
      if (safeCompare(submitted, authToken)) {
        setCookie(c, "autopilot_token", authToken, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          secure: options?.secureCookie,
        });
        return c.redirect("/");
      }
      return c.html(loginPage("Invalid token"), 401);
    });

    app.post("/auth/logout", (c) => {
      deleteCookie(c, "autopilot_token", { path: "/" });
      return c.redirect("/");
    });
  }

  // --- HTML Shell ---
  app.get("/", (c) => {
    const authEnabled = !!options?.authToken;
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <title>autopilot</title>
            <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
            <script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js" integrity="sha384-HGfztofotfshcF7+8n44JQL2oJmowVChPTg48S+jvZoztPfvwD79OC/LTtG6dMp+" crossorigin="anonymous"></script>
            <style>${raw(DASHBOARD_CSS)}</style>
          </head>
          <body>
            <header>
              <h1>autopilot</h1>
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
              ${
                authEnabled
                  ? html`<form method="POST" action="/auth/logout">
                    <button type="submit" class="pause-btn">Logout</button>
                  </form>`
                  : ""
              }
              <div
                id="planning-btn"
                hx-get="/partials/planning-button"
                hx-trigger="load, every 5s"
                hx-swap="innerHTML"
              ></div>
              <div
                class="stats-bar"
                hx-get="/partials/stats"
                hx-trigger="every 5s"
                hx-swap="innerHTML"
              ></div>
              <div
                class="budget-bar"
                hx-get="/partials/budget"
                hx-trigger="load, every 30s"
                hx-swap="innerHTML"
              ></div>
              <div
                class="analytics-bar"
                hx-get="/partials/analytics"
                hx-trigger="load, every 30s"
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
                <div class="section-title">Needs Review</div>
                <div
                  id="triage-list"
                  hx-get="/partials/triage"
                  hx-trigger="load, every 10s"
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

  app.get("/api/analytics", (c) => {
    const analytics = state.getAnalytics();
    if (!analytics) {
      return c.json({ enabled: false });
    }
    const today = state.getTodayAnalytics();
    return c.json({ enabled: true, ...analytics, ...(today ?? {}) });
  });

  app.get("/api/budget", (c) => {
    if (!options?.config) {
      return c.json({ enabled: false });
    }
    const snapshot = state.getBudgetSnapshot(options.config);
    return c.json({ enabled: true, ...snapshot });
  });

  app.get("/health", (c) => {
    const health = computeHealth(state);
    const httpStatus = health.status === "fail" ? 503 : 200;
    return c.json(health, httpStatus);
  });

  app.post("/api/planning", (c) => {
    if (state.getPlanningStatus().running) {
      return c.json({ error: "Planning already running" }, 409);
    }
    try {
      options?.triggerPlanning?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Planning trigger failed: ${msg}` }, 500);
    }
    return c.json({ triggered: true });
  });

  app.post("/api/cancel/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    if (!state.getAgent(agentId)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const cancelled = state.cancelAgent(agentId);
    return c.json({ cancelled });
  });

  app.post("/api/retry/:historyId", async (c) => {
    const historyId = c.req.param("historyId");
    const hist = state.getHistory().find((h) => h.id === historyId);
    if (!hist) {
      return c.json({ error: "History item not found" }, 404);
    }
    if (hist.status === "completed") {
      return c.json({ error: "Cannot retry a completed issue" }, 400);
    }
    const alreadyRunning = state
      .getRunningAgents()
      .some((a) => a.issueId === hist.issueId);
    if (alreadyRunning) {
      return c.json({ error: "Issue is already running" }, 409);
    }
    if (!hist.linearIssueId) {
      return c.json({ error: "No Linear issue ID available for retry" }, 400);
    }
    if (options?.retryIssue) {
      try {
        await options.retryIssue(hist.linearIssueId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `Retry failed: ${msg}` }, 500);
      }
    }
    return c.json({ retried: true });
  });

  app.post("/api/triage/:issueId/approve", async (c) => {
    const issueId = c.req.param("issueId");
    if (!options?.approveTriageIssue) {
      return c.json({ error: "Triage not configured" }, 400);
    }
    try {
      await options.approveTriageIssue(issueId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Approve failed: ${msg}` }, 500);
    }
    return c.json({ approved: true });
  });

  app.post("/api/triage/:issueId/reject", async (c) => {
    const issueId = c.req.param("issueId");
    if (!options?.rejectTriageIssue) {
      return c.json({ error: "Triage not configured" }, 400);
    }
    try {
      await options.rejectTriageIssue(issueId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Reject failed: ${msg}` }, 500);
    }
    return c.json({ rejected: true });
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

  app.get("/partials/planning-button", (c) => {
    const planningRunning = state.getPlanningStatus().running;
    return c.html(
      html`<button
        class="action-btn ${planningRunning ? "disabled" : ""}"
        hx-post="/api/planning"
        hx-target="#planning-btn"
        hx-swap="innerHTML"
        hx-select="button"
        ${planningRunning ? "disabled" : ""}
      >
        ${planningRunning ? "Planning..." : "Trigger Planning"}
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
            return `<div class="agent-card" hx-get="/partials/activity/${escapeHtml(a.id)}" hx-target="#main-panel" hx-swap="innerHTML">
            <div style="display:flex;align-items:center;justify-content:space-between"><span><span class="status-dot running"></span><span class="issue-id">${escapeHtml(a.issueId)}</span></span><button class="action-btn danger" hx-post="/api/cancel/${escapeHtml(a.id)}" hx-confirm="Cancel this agent?" onclick="event.stopPropagation()">Cancel</button></div>
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
        const savedLogs = state.getActivityLogsForRun(id);
        if (savedLogs.length > 0) {
          return c.html(html`
            <div>
              <div style="display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border)">
                <div>
                  <span class="status-dot ${hist.status}"></span>
                  <strong>${hist.issueId}</strong> — ${hist.issueTitle}
                </div>
                <div class="meta">${durationStr} &middot; ${String(savedLogs.length)} activities${costStr ? ` &middot; ${costStr}` : ""}</div>
              </div>
              ${raw(
                savedLogs
                  .map((act) => {
                    const time = new Date(act.timestamp).toLocaleTimeString(
                      "en-US",
                      { hour12: false },
                    );
                    let badgeHtml = `<span class="type-badge ${act.type}">${act.type}</span>`;
                    let summaryText = act.summary;
                    if (act.type === "tool_use") {
                      const colonIdx = act.summary.indexOf(": ");
                      if (colonIdx !== -1) {
                        badgeHtml = `<span class="type-badge ${act.type}">${act.summary.slice(0, colonIdx)}</span>`;
                        summaryText = act.summary.slice(colonIdx + 2);
                      }
                    } else if (act.type === "text") {
                      badgeHtml = "";
                    }
                    return `<div class="activity-item">
                      <span class="time">${time}</span>
                      ${badgeHtml}
                      ${escapeHtml(summaryText)}
                    </div>`;
                  })
                  .join(""),
              )}
            </div>
          `);
        }
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
              // For tool_use, parse "ToolName: detail" format and show tool name as badge
              // For text, skip the badge entirely and just show the text
              let badgeHtml = `<span class="type-badge ${act.type}">${act.type}</span>`;
              let summaryText = act.summary;
              if (act.type === "tool_use") {
                const colonIdx = act.summary.indexOf(": ");
                if (colonIdx !== -1) {
                  badgeHtml = `<span class="type-badge ${act.type}">${act.summary.slice(0, colonIdx)}</span>`;
                  summaryText = act.summary.slice(colonIdx + 2);
                }
              } else if (act.type === "text") {
                badgeHtml = "";
              }
              return `<div class="activity-item">
                <span class="time">${time}</span>
                ${badgeHtml}
                ${escapeHtml(summaryText)}
                ${detailHtml}
              </div>`;
            })
            .join(""),
        )}
        ${agent.status === "running" ? html`<div class="activity-status"><span class="dot"></span> ${randomSaying()}</div>` : ""}
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
            const canRetry = h.status !== "completed" && h.linearIssueId;
            const retryBtn = canRetry
              ? `<button class="action-btn" hx-post="/api/retry/${escapeHtml(h.id)}" onclick="event.stopPropagation()">Retry</button>`
              : "";
            return `<div class="history-card" hx-get="/partials/activity/${escapeHtml(h.id)}" hx-target="#main-panel" hx-swap="innerHTML" style="cursor:pointer">
            <div style="display:flex;align-items:center;justify-content:space-between"><span><span class="status-dot ${h.status}"></span><span class="issue-id">${escapeHtml(h.issueId)}</span> ${durationStr} ${costStr}</span>${retryBtn}</div>
            <div class="title">${escapeHtml(h.issueTitle)}</div>
          </div>`;
          })
          .join(""),
      )}`,
    );
  });

  app.get("/partials/budget", (c) => {
    if (!options?.config) {
      return c.html(html`<div></div>`);
    }
    const snap = state.getBudgetSnapshot(options.config);
    if (snap.dailyLimit <= 0 && snap.monthlyLimit <= 0) {
      return c.html(html`<div></div>`);
    }
    let colorStyle = "";
    if (snap.exhausted) {
      colorStyle = "color: var(--red)";
    } else if (snap.warning) {
      colorStyle = "color: var(--yellow)";
    }
    const parts: string[] = [];
    if (snap.dailyLimit > 0) {
      parts.push(
        `Daily: $${snap.dailySpend.toFixed(2)} / $${snap.dailyLimit.toFixed(2)}`,
      );
    }
    if (snap.monthlyLimit > 0) {
      parts.push(
        `Monthly: $${snap.monthlySpend.toFixed(2)} / $${snap.monthlyLimit.toFixed(2)}`,
      );
    }
    const text = parts.join("  |  ");
    return c.html(html`<span style="${colorStyle}">${text}</span>`);
  });

  app.get("/partials/triage", async (c) => {
    if (!options?.triageIssues) {
      return c.html(html`<div></div>`);
    }
    const issues = await options.triageIssues();
    if (issues.length === 0) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          No issues awaiting review
        </div>`,
      );
    }
    const priorityNames: Record<number, string> = {
      1: "Urgent",
      2: "High",
      3: "Normal",
      4: "Low",
    };
    return c.html(
      html`${raw(
        issues
          .map((issue) => {
            const priorityName = priorityNames[issue.priority] ?? "Low";
            return `<div class="triage-card">
              <div style="display:flex;align-items:center;justify-content:space-between"><span class="issue-id">${escapeHtml(issue.identifier)}</span><span style="font-size:11px;color:var(--text-dim)">${escapeHtml(priorityName)}</span></div>
              <div class="title">${escapeHtml(issue.title)}</div>
              <div class="triage-actions">
                <button class="action-btn approve" hx-post="/api/triage/${escapeHtml(issue.id)}/approve" onclick="event.stopPropagation()">Approve</button>
                <button class="action-btn danger" hx-post="/api/triage/${escapeHtml(issue.id)}/reject" onclick="event.stopPropagation()">Reject</button>
              </div>
            </div>`;
          })
          .join(""),
      )}`,
    );
  });

  app.get("/partials/analytics", (c) => {
    const analytics = state.getAnalytics();
    if (!analytics) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          Analytics not available (persistence disabled)
        </div>`,
      );
    }
    const successPct = Math.round(analytics.successRate * 100);
    const avgDuration =
      analytics.avgDurationMs > 0
        ? `${Math.round(analytics.avgDurationMs / 1000)}s`
        : "n/a";
    const totalCost =
      analytics.totalCostUsd > 0
        ? `$${analytics.totalCostUsd.toFixed(2)}`
        : "$0.00";
    return c.html(html`
      <div class="stat">
        <div class="value">${String(analytics.totalRuns)}</div>
        <div class="label">Total Runs</div>
      </div>
      <div class="stat">
        <div class="value">${String(successPct)}%</div>
        <div class="label">Success Rate</div>
      </div>
      <div class="stat">
        <div class="value">${avgDuration}</div>
        <div class="label">Avg Duration</div>
      </div>
      <div class="stat">
        <div class="value">${totalCost}</div>
        <div class="label">Total Cost</div>
      </div>
    `);
  });

  return app;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
