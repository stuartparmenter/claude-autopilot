import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { DASHBOARD_CSS } from "./dashboard-styles";
import type { AutopilotConfig } from "./lib/config";
import { deleteOAuthToken, saveOAuthToken } from "./lib/db";
import { resetClient } from "./lib/linear";
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  saveStoredToken,
} from "./lib/linear-oauth";
import {
  parseGitHubEventType,
  parseLinearEventType,
  verifyGitHubSignature,
  verifyLinearSignature,
  type WebhookTrigger,
} from "./lib/webhooks";
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

export interface WebhookOptions {
  trigger: WebhookTrigger;
  linearSecret: string;
  githubSecret: string;
  readyStateName: string;
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
  /** DB instance used to persist OAuth tokens from the callback route. */
  db?: Database;
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
      sessionCount: number;
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
        sessionCount: snap.planningHistory.length,
      },
      projects: {
        status: projectsStatus,
      },
    },
  };
}

export function createApp(
  state: AppState,
  options?: DashboardOptions,
  webhooks?: WebhookOptions,
): Hono {
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

  // --- Linear OAuth routes ---

  app.get("/auth/linear", (c) => {
    const clientId = process.env.LINEAR_CLIENT_ID;
    if (!clientId) {
      return c.html(
        "<p>Error: LINEAR_CLIENT_ID environment variable is not set.</p>",
        400,
      );
    }
    const state = randomBytes(16).toString("hex");
    setCookie(c, "oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600, // 10 minutes
      secure: options?.secureCookie,
    });
    const redirectUri = new URL("/auth/linear/callback", c.req.url).toString();
    const url = buildOAuthUrl(clientId, redirectUri, state);
    return c.redirect(url);
  });

  app.get("/auth/linear/callback", async (c) => {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const error = c.req.query("error");
    const storedState = getCookie(c, "oauth_state");

    // Clear the state cookie regardless of outcome
    deleteCookie(c, "oauth_state", { path: "/" });

    if (error) {
      return c.html(
        `<p>Linear OAuth error: ${escapeHtml(error)}</p><p><a href="/">Back to dashboard</a></p>`,
        400,
      );
    }

    // Verify state to prevent CSRF attacks
    if (!storedState || !stateParam || !safeCompare(stateParam, storedState)) {
      return c.html(
        "<p>Error: OAuth state mismatch. Please try again.</p>",
        400,
      );
    }

    if (!code) {
      return c.html("<p>Error: No authorization code received.</p>", 400);
    }

    const clientId = process.env.LINEAR_CLIENT_ID;
    const clientSecret = process.env.LINEAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return c.html(
        "<p>Error: LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set.</p>",
        400,
      );
    }

    try {
      const redirectUri = new URL(
        "/auth/linear/callback",
        c.req.url,
      ).toString();
      const token = await exchangeCodeForToken(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      if (options?.db) {
        // Write to legacy table to update in-memory cache for getCurrentLinearToken()
        saveStoredToken(options.db, token);
        // Also write to oauth_tokens table for ENG-107 auto-refresh client
        saveOAuthToken(options.db, "linear", {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? "",
          expiresAt: token.expiresAt,
          tokenType: "Bearer",
          scope: "read,write,issues:create,comments:create",
          actor: "application",
        });
      }
      // Force the Linear client to re-initialize with the new token
      resetClient();
      return c.redirect("/");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.html(
        `<p>Error: ${escapeHtml(msg)}</p><p><a href="/">Back to dashboard</a></p>`,
        500,
      );
    }
  });

  app.post("/auth/linear/disconnect", (c) => {
    if (options?.db) {
      deleteOAuthToken(options.db, "linear");
    }
    return c.redirect("/");
  });

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
              <div
                class="cost-trends-bar"
                hx-get="/partials/cost-trends"
                hx-trigger="load, every 60s"
                hx-swap="innerHTML"
              ></div>
              <div
                class="failure-analysis-bar"
                hx-get="/partials/failure-analysis"
                hx-trigger="load, every 60s"
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
                <div class="section-title">Planning History</div>
                <div
                  id="planning-history-list"
                  hx-get="/partials/planning-history"
                  hx-trigger="load, every 30s"
                  hx-swap="innerHTML"
                ></div>
                <div class="section-title">Cost Tracking</div>
                <div
                  id="cost-section"
                  hx-get="/partials/costs"
                  hx-trigger="load, every 30s"
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

  app.get("/api/cost-trends", (c) => {
    const trends = state.getCostTrends();
    if (!trends) {
      return c.json({ enabled: false });
    }
    return c.json({ enabled: true, ...trends });
  });

  app.get("/api/costs", (c) => {
    const analytics = state.getAnalytics();
    if (!analytics) {
      return c.json({ enabled: false });
    }
    const dailyCosts = state.getDailyCosts(30);
    const perIssueCosts = state.getPerIssueCosts(50);
    return c.json({
      enabled: true,
      totalCostUsd: analytics.totalCostUsd,
      dailyCosts,
      perIssueCosts,
    });
  });

  app.get("/api/costs/daily", (c) => {
    const days = parseInt(c.req.query("days") ?? "30", 10);
    const safeDays = Math.min(Math.max(days, 1), 365);
    const dailyCosts = state.getDailyCosts(safeDays);
    return c.json({ dailyCosts });
  });

  app.get("/api/planning/history", (c) => {
    const history = state.getPlanningHistory();
    return c.json({ sessions: history });
  });

  app.get("/api/failure-analysis", (c) => {
    const analysis = state.getFailureAnalysis();
    if (!analysis) {
      return c.json({ enabled: false });
    }
    return c.json({ enabled: true, ...analysis });
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
      <div class="stat">
        <div class="value">${String(snap.planningHistory.length)}</div>
        <div class="label">Plans</div>
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
              ${raw(savedLogs.map((act) => renderActivityItem(act)).join(""))}
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
        ${raw(activities.map((act) => renderActivityItem(act, verbose)).join(""))}
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

  app.get("/partials/planning-history", (c) => {
    const sessions = state.getPlanningHistory();
    if (sessions.length === 0) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          No planning sessions yet
        </div>`,
      );
    }
    return c.html(
      html`${raw(
        sessions
          .slice(0, 10)
          .map((s) => {
            const durationSec = Math.round((s.finishedAt - s.startedAt) / 1000);
            const durationStr =
              durationSec >= 60
                ? `${Math.floor(durationSec / 60)}m`
                : `${durationSec}s`;
            const costStr = s.costUsd ? `$${s.costUsd.toFixed(4)}` : "";
            const dateStr = new Date(s.finishedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });
            const timeStr = new Date(s.finishedAt).toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
            });
            return `<div class="history-card">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span><span class="status-dot ${escapeHtml(s.status)}"></span>Planning</span>
              <span style="font-size:11px;color:var(--text-dim)">${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</span>
            </div>
            <div class="meta">${escapeHtml(durationStr)}${costStr ? ` &middot; ${escapeHtml(costStr)}` : ""}${s.issuesFiledCount > 0 ? ` &middot; ${s.issuesFiledCount} issues filed` : ""}</div>
            ${s.summary ? `<div class="title">${escapeHtml(s.summary)}</div>` : ""}
          </div>`;
          })
          .join(""),
      )}`,
    );
  });

  // --- Webhook endpoints ---

  if (webhooks) {
    const { trigger, linearSecret, githubSecret, readyStateName } = webhooks;
    // Track delivery IDs to deduplicate retried webhook deliveries
    const processedDeliveries = new Set<string>();

    app.post("/webhooks/linear", async (c) => {
      const rawBody = await c.req.text();
      const signature = c.req.header("x-linear-signature") ?? "";
      if (!verifyLinearSignature(linearSecret, rawBody, signature)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      const deliveryId =
        c.req.header("x-linear-delivery") ?? crypto.randomUUID();
      if (processedDeliveries.has(deliveryId)) {
        return c.json({ ok: true });
      }
      processedDeliveries.add(deliveryId);

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const eventType = parseLinearEventType(
        { event: c.req.header("x-linear-event") },
        body,
        readyStateName,
      );
      if (eventType === "issue_ready") {
        trigger.fire();
      }

      return c.json({ ok: true });
    });

    app.post("/webhooks/github", async (c) => {
      const rawBody = await c.req.text();
      const signature = c.req.header("x-hub-signature-256") ?? "";
      if (!verifyGitHubSignature(githubSecret, rawBody, signature)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      const deliveryId =
        c.req.header("x-github-delivery") ?? crypto.randomUUID();
      if (processedDeliveries.has(deliveryId)) {
        return c.json({ ok: true });
      }
      processedDeliveries.add(deliveryId);

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const eventType = parseGitHubEventType(
        { event: c.req.header("x-github-event") },
        body,
      );
      if (eventType === "ci_failure") {
        trigger.fire();
      }

      return c.json({ ok: true });
    });
  } else {
    app.post("/webhooks/linear", (c) =>
      c.json({ error: "Webhooks not configured" }, 404),
    );
    app.post("/webhooks/github", (c) =>
      c.json({ error: "Webhooks not configured" }, 404),
    );
  }

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

  app.get("/partials/cost-trends", (c) => {
    const trends = state.getCostTrends();
    if (!trends) {
      return c.html(html`<div></div>`);
    }
    const recentDays = trends.daily.slice(-7);
    if (recentDays.length === 0) {
      return c.html(html`<div></div>`);
    }
    const maxCost = Math.max(...recentDays.map((d) => d.totalCost), 0.01);
    const dayRows = recentDays
      .map((d) => {
        const pct = Math.round((d.totalCost / maxCost) * 100);
        const dateLabel = escapeHtml(d.date.slice(5)); // "MM-DD"
        const amount = escapeHtml(`$${d.totalCost.toFixed(2)}`);
        return `<div class="cost-trend-row"><span class="cost-trend-date">${dateLabel}</span><div class="cost-trend-bar-track"><div class="cost-trend-bar-fill" style="width:${pct}%"></div></div><span class="cost-trend-amount">${amount}</span></div>`;
      })
      .join("");

    const statusParts = trends.byStatus.map(
      (b) =>
        `${escapeHtml(b.status.charAt(0).toUpperCase() + b.status.slice(1))}: $${b.totalCost.toFixed(2)}`,
    );
    const statusLine = statusParts.join(" | ");

    let weekLine = "";
    if (trends.weekly.length >= 2) {
      const thisWeek = trends.weekly[trends.weekly.length - 1];
      const lastWeek = trends.weekly[trends.weekly.length - 2];
      weekLine = `This wk: $${thisWeek.totalCost.toFixed(2)}  Last wk: $${lastWeek.totalCost.toFixed(2)}`;
    } else if (trends.weekly.length === 1) {
      weekLine = `This wk: $${trends.weekly[0].totalCost.toFixed(2)}`;
    }

    return c.html(html`
      <div class="cost-trends-section">
        ${raw(dayRows)}
        ${
          weekLine
            ? html`<div class="cost-trends-summary">${weekLine}</div>`
            : ""
        }
        ${
          statusLine
            ? html`<div class="cost-trends-summary">${statusLine}</div>`
            : ""
        }
      </div>
    `);
  });

  app.get("/partials/costs", (c) => {
    const dailyCosts = state.getDailyCosts(7);
    const perIssueCosts = state.getPerIssueCosts(10);

    if (dailyCosts.length === 0 && perIssueCosts.length === 0) {
      return c.html(
        html`<div
          style="padding: 12px 16px; color: var(--text-dim); font-size: 12px"
        >
          No cost data available yet
        </div>`,
      );
    }

    const maxDailyCost = Math.max(
      ...dailyCosts.map((d) => d.totalCostUsd),
      0.01,
    );

    return c.html(html`
      <div class="cost-section">
        ${
          dailyCosts.length > 0
            ? html`
              <div class="cost-subtitle">Last 7 Days</div>
              ${raw(
                dailyCosts
                  .map((d) => {
                    const pct = Math.round(
                      (d.totalCostUsd / maxDailyCost) * 100,
                    );
                    return `<div class="cost-day-row">
                  <span class="cost-date">${escapeHtml(d.date.slice(5))}</span>
                  <div class="cost-bar-bg"><div class="cost-bar-fill" style="width:${pct}%"></div></div>
                  <span class="cost-amount">$${d.totalCostUsd.toFixed(2)}</span>
                  <span class="cost-runs">${d.runCount}r</span>
                </div>`;
                  })
                  .join(""),
              )}
            `
            : ""
        }
        ${
          perIssueCosts.length > 0
            ? html`
              <div class="cost-subtitle">Top Issues by Cost</div>
              ${raw(
                perIssueCosts
                  .map((i) => {
                    return `<div class="cost-issue-row">
                  <span class="issue-id">${escapeHtml(i.issueId)}</span>
                  <span class="cost-amount">$${i.totalCostUsd.toFixed(2)}</span>
                  <span class="cost-runs">${i.runCount}r</span>
                </div>`;
                  })
                  .join(""),
              )}
            `
            : ""
        }
      </div>
    `);
  });

  app.get("/partials/failure-analysis", (c) => {
    const analysis = state.getFailureAnalysis();
    if (!analysis) {
      return c.html(html`<div></div>`);
    }

    const typeParts = analysis.byType.map(
      (b) =>
        `${escapeHtml(b.status === "timed_out" ? "Timed Out" : "Failed")}: ${b.count}`,
    );
    const typeLine = typeParts.join(" | ");

    if (!typeLine) {
      return c.html(html`<div></div>`);
    }

    const recentDays = analysis.trend.slice(-7);
    const maxRate = Math.max(...recentDays.map((d) => d.failureRate), 0.01);
    const dayRows = recentDays
      .map((d) => {
        const pct = Math.round((d.failureRate / maxRate) * 100);
        const dateLabel = escapeHtml(d.date.slice(5)); // "MM-DD"
        const rateLabel = escapeHtml(`${Math.round(d.failureRate * 100)}%`);
        return `<div class="cost-trend-row"><span class="cost-trend-date">${dateLabel}</span><div class="cost-trend-bar-track"><div class="cost-trend-bar-fill" style="width:${pct}%;background:var(--red)"></div></div><span class="cost-trend-amount">${rateLabel}</span></div>`;
      })
      .join("");

    const repeatRows = analysis.repeatFailures
      .map((r) => {
        const issueId = escapeHtml(r.issueId);
        const issueTitle = escapeHtml(r.issueTitle);
        const lastError = r.lastError ? escapeHtml(r.lastError) : "";
        return `<div class="repeat-failure-item"><span class="repeat-failure-count">${r.failureCount}x</span><span title="${issueTitle}">${issueId}</span>${lastError ? `<span class="repeat-failure-error">${lastError}</span>` : ""}</div>`;
      })
      .join("");

    return c.html(html`
      <div class="failure-analysis-section">
        <div class="cost-trends-summary">${typeLine}</div>
        ${recentDays.length > 0 ? raw(dayRows) : ""}
        ${repeatRows ? raw(repeatRows) : ""}
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

import type { ActivityEntry } from "./state";

/** Render a single activity entry as an HTML string for the dashboard feed. */
export function renderActivityItem(
  act: ActivityEntry,
  verbose?: boolean,
): string {
  const time = new Date(act.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
  });
  const detailHtml =
    verbose && act.detail
      ? `<div class="detail-text">${escapeHtml(act.detail)}</div>`
      : "";

  // Subagent prefix badge
  const subBadge = act.isSubagent
    ? `<span class="type-badge subagent">subagent</span>`
    : "";

  // Main badge: tool_use parses "ToolName: detail", text skips badge
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

  const itemClass = act.isSubagent ? "activity-item subagent" : "activity-item";
  return `<div class="${itemClass}">
    <span class="time">${time}</span>
    ${subBadge}${badgeHtml}
    ${escapeHtml(summaryText)}
    ${detailHtml}
  </div>`;
}
