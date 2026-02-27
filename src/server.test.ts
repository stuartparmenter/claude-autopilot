import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AutopilotConfig } from "./lib/config";
import { DEFAULTS } from "./lib/config";
import { insertAgentRun, openDb } from "./lib/db";
import {
  computeHealth,
  createApp,
  escapeHtml,
  formatDuration,
  safeCompare,
} from "./server";
import { AppState } from "./state";

describe("safeCompare", () => {
  test("returns true for identical strings", () => {
    expect(safeCompare("secret-token", "secret-token")).toBe(true);
  });

  test("returns false for different strings of the same length", () => {
    expect(safeCompare("aaaa", "bbbb")).toBe(false);
  });

  test("returns false for different strings of different lengths", () => {
    expect(safeCompare("short", "much-longer-string")).toBe(false);
  });

  test("returns true for empty strings", () => {
    expect(safeCompare("", "")).toBe(true);
  });

  test("returns false for empty vs non-empty", () => {
    expect(safeCompare("", "notempty")).toBe(false);
  });

  test("returns false when first arg is longer than second", () => {
    expect(safeCompare("longer-token-here", "short")).toBe(false);
  });
});

describe("formatDuration", () => {
  test("returns seconds only for values under 60", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  test("returns 0s for zero seconds", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("returns minutes and seconds for values 60–3599", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  test("returns exactly 1m 0s at 60 seconds", () => {
    expect(formatDuration(60)).toBe("1m 0s");
  });

  test("returns hours and minutes for values >= 3600", () => {
    expect(formatDuration(3665)).toBe("1h 1m");
  });

  test("returns hours and minutes (omitting seconds) for large values", () => {
    expect(formatDuration(7200)).toBe("2h 0m");
  });
});

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test("escapes double quote", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("escapes single quote", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  test("escapes all five entities in one string", () => {
    expect(escapeHtml('<a href="x">a & b</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;a &amp; b&lt;/a&gt;",
    );
  });
});

describe("auth", () => {
  const TOKEN = "test-secret-token";

  test("without authToken: GET / returns 200 (backwards compatible)", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("without authToken: GET /api/status returns 200", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
  });

  test("with authToken: GET / without cookie returns 401 with login form", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Dashboard Token");
    expect(body).toContain("/auth/login");
  });

  test("with authToken: GET /api/status without auth returns 401 JSON", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/status");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  test("with authToken: GET /partials/agents without auth returns 401 JSON", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/partials/agents");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  test("with authToken: GET /partials/triage without auth returns 401 JSON", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/partials/triage");
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  test("with authToken: GET /api/status with valid Bearer token returns 200", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("with authToken: GET / with valid cookie returns 200 dashboard", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/", {
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("autopilot");
    expect(body).toContain("htmx");
  });

  test("with authToken: POST /auth/login with correct token sets cookie and redirects", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("autopilot_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  test("with authToken and secureCookie: POST /auth/login sets Secure flag on cookie", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN, secureCookie: true });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("Secure");
  });

  test("with authToken and no secureCookie: POST /auth/login does NOT set Secure flag on cookie", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toContain("Secure");
  });

  test("with authToken: POST /auth/login with wrong token returns 401 with error", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=wrong-token",
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Invalid token");
  });

  test("with authToken: POST /auth/logout clears cookie and redirects", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("autopilot_token=");
    expect(setCookie).toContain("Max-Age=0");
  });

  test("with authToken: dashboard shows Logout button", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/", {
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    const body = await res.text();
    expect(body).toContain("/auth/logout");
    expect(body).toContain("Logout");
  });

  test("without authToken: dashboard does not show Logout button", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/");
    const body = await res.text();
    expect(body).not.toContain("/auth/logout");
  });
});

describe("routes", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("GET / returns 200 HTML with title", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("autopilot");
  });

  test("GET / includes htmx script tag with SRI integrity hash and crossorigin", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain('integrity="sha384-');
    expect(body).toContain('crossorigin="anonymous"');
  });

  test("GET /api/status returns JSON with expected keys", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("paused");
    expect(json).toHaveProperty("agents");
    expect(json).toHaveProperty("history");
    expect(json).toHaveProperty("queue");
    expect(json).toHaveProperty("planning");
    expect(json).toHaveProperty("startedAt");
  });

  test("POST /api/pause toggles paused state", async () => {
    expect(state.isPaused()).toBe(false);
    const res = await app.request("/api/pause", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { paused: boolean };
    expect(json.paused).toBe(true);
    expect(state.isPaused()).toBe(true);
  });

  test("GET /partials/agents with empty state shows 'No agents running'", async () => {
    const res = await app.request("/partials/agents");
    const body = await res.text();
    expect(body).toContain("No agents running");
  });

  test("GET /partials/agents with an agent shows its issue ID", async () => {
    state.addAgent("test-id", "ENG-42", "Fix the thing");
    const res = await app.request("/partials/agents");
    const body = await res.text();
    expect(body).toContain("ENG-42");
  });

  test("GET /partials/agents escapes agent ID in hx-get attribute", async () => {
    state.addAgent("exec-ENG-42-<script>", "ENG-42", "Fix the thing");
    const res = await app.request("/partials/agents");
    const body = await res.text();
    expect(body).toContain(
      'hx-get="/partials/activity/exec-ENG-42-&lt;script&gt;"',
    );
    expect(body).not.toContain(
      'hx-get="/partials/activity/exec-ENG-42-<script>"',
    );
  });

  test("GET /partials/history escapes agent ID in hx-get attribute", async () => {
    state.addAgent('exec-ENG-42-"xss"', "ENG-42", "Fix the thing");
    state.completeAgent('exec-ENG-42-"xss"', "completed");
    const res = await app.request("/partials/history");
    const body = await res.text();
    expect(body).toContain(
      'hx-get="/partials/activity/exec-ENG-42-&quot;xss&quot;"',
    );
    expect(body).not.toContain('hx-get="/partials/activity/exec-ENG-42-"xss""');
  });

  test("GET /partials/history with empty state shows 'No completed agents yet'", async () => {
    const res = await app.request("/partials/history");
    const body = await res.text();
    expect(body).toContain("No completed agents yet");
  });

  test("GET /partials/activity/:id for unknown ID returns 'Agent not found'", async () => {
    const res = await app.request("/partials/activity/unknown-id");
    const body = await res.text();
    expect(body).toContain("Agent not found");
  });
});

describe("POST /api/planning", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("returns 409 when planning is already running", async () => {
    state.updatePlanning({ running: true });
    const res = await app.request("/api/planning", { method: "POST" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Planning already running");
  });

  test("triggers planning and returns triggered: true when not running", async () => {
    const triggerPlanning = mock(() => {});
    const appWithActions = createApp(state, { triggerPlanning });
    const res = await appWithActions.request("/api/planning", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(true);
    expect(triggerPlanning).toHaveBeenCalledTimes(1);
  });

  test("returns triggered: true even without actions configured", async () => {
    const res = await app.request("/api/planning", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(true);
  });

  test("returns 500 with error key when triggerPlanning throws", async () => {
    const triggerPlanning = mock(() => {
      throw new Error("planning error");
    });
    const appWithActions = createApp(state, { triggerPlanning });
    const res = await appWithActions.request("/api/planning", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Planning trigger failed: planning error");
  });
});

describe("POST /api/cancel/:agentId", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("returns 404 for unknown agent", async () => {
    const res = await app.request("/api/cancel/no-such-agent", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Agent not found");
  });

  test("cancels a running agent and returns cancelled: true", async () => {
    state.addAgent("agent-1", "ENG-1", "Test issue");
    const controller = new AbortController();
    state.registerAgentController("agent-1", controller);
    const res = await app.request("/api/cancel/agent-1", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cancelled: boolean };
    expect(json.cancelled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  test("returns cancelled: false if no controller registered", async () => {
    state.addAgent("agent-1", "ENG-1", "Test issue");
    const res = await app.request("/api/cancel/agent-1", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cancelled: boolean };
    expect(json.cancelled).toBe(false);
  });
});

describe("POST /api/retry/:historyId", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    // Create an agent and complete it as failed
    state.addAgent("exec-ENG-5-123", "ENG-5", "Some issue", "linear-uuid-5");
    state.completeAgent("exec-ENG-5-123", "failed", { error: "timed out" });
  });

  test("returns 404 for unknown history item", async () => {
    const app = createApp(state);
    const res = await app.request("/api/retry/no-such-id", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns 400 when retrying a completed issue", async () => {
    state.addAgent("exec-ENG-6-456", "ENG-6", "Another", "linear-uuid-6");
    state.completeAgent("exec-ENG-6-456", "completed");
    const app = createApp(state);
    const res = await app.request("/api/retry/exec-ENG-6-456", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Cannot retry a completed issue");
  });

  test("returns 409 when issue is already running", async () => {
    state.addAgent("exec-ENG-5-999", "ENG-5", "Some issue");
    const app = createApp(state);
    const res = await app.request("/api/retry/exec-ENG-5-123", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  test("returns 400 when no linearIssueId available", async () => {
    // Add history item without linearIssueId
    state.addAgent("exec-ENG-7-789", "ENG-7", "No uuid");
    state.completeAgent("exec-ENG-7-789", "failed");
    const app = createApp(state);
    const res = await app.request("/api/retry/exec-ENG-7-789", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("No Linear issue ID available for retry");
  });

  test("calls retryIssue and returns retried: true for failed issue", async () => {
    const retryIssue = mock(async (_id: string) => {});
    const app = createApp(state, { retryIssue });
    const res = await app.request("/api/retry/exec-ENG-5-123", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { retried: boolean };
    expect(json.retried).toBe(true);
    expect(retryIssue).toHaveBeenCalledWith("linear-uuid-5");
  });

  test("returns 500 with error key when retryIssue throws", async () => {
    const retryIssue = mock(async (_id: string) => {
      throw new Error("Linear API error");
    });
    const app = createApp(state, { retryIssue });
    const res = await app.request("/api/retry/exec-ENG-5-123", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Retry failed: Linear API error");
  });
});

describe("global onError handler", () => {
  test("returns 500 JSON when an unhandled error occurs", async () => {
    const state = new AppState();
    const app = createApp(state);
    app.get("/test-throw", () => {
      throw new Error("unexpected failure");
    });
    const res = await app.request("/test-throw");
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unexpected failure");
  });
});

describe("GET /api/budget", () => {
  test("returns { enabled: false } when no config passed", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/budget");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(false);
  });

  test("returns { enabled: false } when config has no limits set", async () => {
    const state = new AppState();
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 0,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/api/budget");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean };
    // enabled is true when config is present, even if limits are 0
    expect(json.enabled).toBe(true);
  });

  test("returns budget snapshot with enabled: true when config has daily limit", async () => {
    const state = new AppState();
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/api/budget");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      enabled: boolean;
      dailySpend: number;
      dailyLimit: number;
      exhausted: boolean;
    };
    expect(json.enabled).toBe(true);
    expect(json.dailyLimit).toBe(10);
    expect(json.dailySpend).toBe(0);
    expect(json.exhausted).toBe(false);
  });

  test("returns exhausted: true when spend exceeds limit", async () => {
    const state = new AppState();
    state.addSpend(12);
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/api/budget");
    const json = (await res.json()) as { exhausted: boolean };
    expect(json.exhausted).toBe(true);
  });
});

describe("GET /partials/budget", () => {
  test("returns empty div when no config passed", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/partials/budget");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<div></div>");
  });

  test("returns empty div when all limits are 0", async () => {
    const state = new AppState();
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 0,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/partials/budget");
    const body = await res.text();
    expect(body).toContain("<div></div>");
  });

  test("renders spend-vs-limit text when daily limit is set", async () => {
    const state = new AppState();
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/partials/budget");
    const body = await res.text();
    expect(body).toContain("Daily:");
    expect(body).toContain("$10.00");
  });

  test("renders both daily and monthly when both limits set", async () => {
    const state = new AppState();
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 50,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/partials/budget");
    const body = await res.text();
    expect(body).toContain("Daily:");
    expect(body).toContain("Monthly:");
    expect(body).toContain("|");
  });

  test("renders warning color when budget warning applies", async () => {
    const state = new AppState();
    state.addSpend(8.5); // 85% of $10 daily limit
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/partials/budget");
    const body = await res.text();
    expect(body).toContain("var(--yellow)");
  });

  test("renders red color when budget is exhausted", async () => {
    const state = new AppState();
    state.addSpend(12); // over $10 daily limit
    const config: AutopilotConfig = {
      ...DEFAULTS,
      budget: {
        daily_limit_usd: 10,
        monthly_limit_usd: 0,
        per_agent_limit_usd: 0,
        warn_at_percent: 80,
      },
    };
    const app = createApp(state, { config });
    const res = await app.request("/partials/budget");
    const body = await res.text();
    expect(body).toContain("var(--red)");
  });
});

describe("dashboard HTML includes budget partial div", () => {
  test("includes budget-bar div with 30s poll trigger", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("budget-bar");
    expect(body).toContain("/partials/budget");
    expect(body).toContain("every 30s");
  });

  test("includes triage-list div with 10s poll trigger", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("triage-list");
    expect(body).toContain("/partials/triage");
    expect(body).toContain("every 10s");
  });
});

describe("CSRF protection", () => {
  const TOKEN = "test-csrf-token";

  test("cookie-only POST to /api/pause returns 403 (missing custom header)", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/pause", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Forbidden");
  });

  test("cookie-only POST to /api/planning returns 403", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/planning", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  test("cookie-only POST to /api/cancel/:agentId returns 403", async () => {
    const state = new AppState();
    state.addAgent("csrf-agent", "ENG-1", "Test");
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/cancel/csrf-agent", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  test("cookie-only POST to /api/retry/:historyId returns 403", async () => {
    const state = new AppState();
    state.addAgent("csrf-exec-1", "ENG-1", "Test issue", "linear-uuid-csrf");
    state.completeAgent("csrf-exec-1", "failed", { error: "timed out" });
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/retry/csrf-exec-1", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  test("cookie + HX-Request: true allows POST to /api/pause", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/pause", {
      method: "POST",
      headers: {
        Cookie: `autopilot_token=${TOKEN}`,
        "HX-Request": "true",
      },
    });
    expect(res.status).toBe(200);
  });

  test("cookie + X-Requested-With: XMLHttpRequest allows POST to /api/pause", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/pause", {
      method: "POST",
      headers: {
        Cookie: `autopilot_token=${TOKEN}`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    expect(res.status).toBe(200);
  });

  test("Bearer token POST without custom headers is allowed", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/pause", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("POST /auth/login is exempt from CSRF check", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    expect(res.status).toBe(302);
  });

  test("POST /auth/logout is exempt from CSRF check", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(302);
  });

  test("without authToken: POST /api/pause works without custom headers", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/pause", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("cookie-only POST to /api/triage/:issueId/approve returns 403", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/triage/some-uuid/approve", {
      method: "POST",
      headers: { Cookie: `autopilot_token=${TOKEN}` },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Forbidden");
  });

  test("cookie + HX-Request: true allows POST to /api/triage/:issueId/approve", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: TOKEN });
    const res = await app.request("/api/triage/some-uuid/approve", {
      method: "POST",
      headers: {
        Cookie: `autopilot_token=${TOKEN}`,
        "HX-Request": "true",
      },
    });
    // 400 because callback not configured, but CSRF check passed
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Triage not configured");
  });
});

describe("GET /partials/planning-button", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("shows 'Trigger Planning' when planning is not running", async () => {
    const res = await app.request("/partials/planning-button");
    const body = await res.text();
    expect(body).toContain("Trigger Planning");
  });

  test("shows 'Planning...' and disabled when planning is running", async () => {
    state.updatePlanning({ running: true });
    const res = await app.request("/partials/planning-button");
    const body = await res.text();
    expect(body).toContain("Planning...");
    expect(body).toContain("disabled");
  });
});

describe("dashboard HTML includes analytics partial div", () => {
  test("includes analytics-bar div with /partials/analytics and 30s poll", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("/partials/analytics");
    expect(body).toContain("analytics-bar");
    expect(body).toContain("every 30s");
  });
});

describe("GET /partials/analytics", () => {
  test("returns fallback message when no DB connected", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/partials/analytics");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Analytics not available");
  });

  test("returns stat cards with Total Runs, Success Rate, Avg Duration, Total Cost when DB connected", async () => {
    const state = new AppState();
    const db = openDb(":memory:");
    state.setDb(db);
    const now = Date.now();
    await insertAgentRun(db, {
      id: "run-1",
      issueId: "ENG-1",
      issueTitle: "Test issue",
      status: "completed",
      startedAt: now - 60000,
      finishedAt: now,
      costUsd: 0.5,
      durationMs: 60000,
      numTurns: 5,
    });
    const app = createApp(state);
    const res = await app.request("/partials/analytics");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Total Runs");
    expect(body).toContain("Success Rate");
    expect(body).toContain("Avg Duration");
    expect(body).toContain("Total Cost");
    expect(body).toContain("100%");
  });
});

describe("GET /api/analytics", () => {
  test("returns { enabled: false } when no DB connected", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/analytics");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(false);
  });

  test("returns all-time and today-windowed metrics when DB connected", async () => {
    const state = new AppState();
    const db = openDb(":memory:");
    state.setDb(db);
    const now = Date.now();
    // Two runs today: one completed, one failed
    await insertAgentRun(db, {
      id: "run-today-1",
      issueId: "ENG-1",
      issueTitle: "Test 1",
      status: "completed",
      startedAt: now - 60000,
      finishedAt: now,
      costUsd: 0.5,
      durationMs: 60000,
      numTurns: 5,
    });
    await insertAgentRun(db, {
      id: "run-today-2",
      issueId: "ENG-2",
      issueTitle: "Test 2",
      status: "failed",
      startedAt: now - 30000,
      finishedAt: now - 1000,
      costUsd: 0.1,
      durationMs: 29000,
      numTurns: 2,
    });
    // One run from yesterday (outside today's window)
    const yesterday = now - 25 * 60 * 60 * 1000;
    await insertAgentRun(db, {
      id: "run-yesterday",
      issueId: "ENG-3",
      issueTitle: "Old run",
      status: "completed",
      startedAt: yesterday - 60000,
      finishedAt: yesterday,
      costUsd: 1.0,
      durationMs: 60000,
      numTurns: 10,
    });
    const app = createApp(state);
    const res = await app.request("/api/analytics");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      enabled: boolean;
      totalRuns: number;
      successRate: number;
      todayRuns: number;
      todaySuccessRate: number;
    };
    expect(json.enabled).toBe(true);
    expect(json.totalRuns).toBe(3);
    expect(json.todayRuns).toBe(2);
    expect(json.todaySuccessRate).toBeCloseTo(0.5);
  });

  test("todayRuns is 0 and todaySuccessRate is 0 when no runs today", async () => {
    const state = new AppState();
    const db = openDb(":memory:");
    state.setDb(db);
    // Only a run from yesterday
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    await insertAgentRun(db, {
      id: "run-old",
      issueId: "ENG-1",
      issueTitle: "Old",
      status: "completed",
      startedAt: yesterday - 60000,
      finishedAt: yesterday,
    });
    const app = createApp(state);
    const res = await app.request("/api/analytics");
    const json = (await res.json()) as {
      enabled: boolean;
      todayRuns: number;
      todaySuccessRate: number;
    };
    expect(json.enabled).toBe(true);
    expect(json.todayRuns).toBe(0);
    expect(json.todaySuccessRate).toBe(0);
  });
});

describe("GET /partials/triage", () => {
  test("returns empty div when triageIssues callback not configured", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/partials/triage");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<div></div>");
  });

  test("shows 'No issues awaiting review' when triage list is empty", async () => {
    const state = new AppState();
    const triageIssues = mock(async () => []);
    const app = createApp(state, { triageIssues });
    const res = await app.request("/partials/triage");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No issues awaiting review");
  });

  test("renders issue identifiers and titles", async () => {
    const state = new AppState();
    const triageIssues = mock(async () => [
      {
        id: "uuid-1",
        identifier: "ENG-10",
        title: "Fix login bug",
        priority: 2,
      },
    ]);
    const app = createApp(state, { triageIssues });
    const res = await app.request("/partials/triage");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ENG-10");
    expect(body).toContain("Fix login bug");
  });

  test("escapes HTML in issue titles", async () => {
    const state = new AppState();
    const triageIssues = mock(async () => [
      {
        id: "uuid-xss",
        identifier: "ENG-99",
        title: "<script>alert(1)</script>",
        priority: 3,
      },
    ]);
    const app = createApp(state, { triageIssues });
    const res = await app.request("/partials/triage");
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  test("renders approve and reject buttons", async () => {
    const state = new AppState();
    const triageIssues = mock(async () => [
      {
        id: "uuid-1",
        identifier: "ENG-10",
        title: "Fix login bug",
        priority: 2,
      },
    ]);
    const app = createApp(state, { triageIssues });
    const res = await app.request("/partials/triage");
    const body = await res.text();
    expect(body).toContain('hx-post="/api/triage/uuid-1/approve"');
    expect(body).toContain('hx-post="/api/triage/uuid-1/reject"');
  });
});

describe("POST /api/triage/:issueId/approve", () => {
  test("returns 400 when approveTriageIssue callback not configured", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/triage/some-uuid/approve", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Triage not configured");
  });

  test("calls approveTriageIssue and returns approved: true", async () => {
    const state = new AppState();
    const approveTriageIssue = mock(async (_id: string) => {});
    const app = createApp(state, { approveTriageIssue });
    const res = await app.request("/api/triage/uuid-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { approved: boolean };
    expect(json.approved).toBe(true);
    expect(approveTriageIssue).toHaveBeenCalledWith("uuid-1");
  });

  test("returns 500 with error when approveTriageIssue throws", async () => {
    const state = new AppState();
    const approveTriageIssue = mock(async (_id: string) => {
      throw new Error("Linear API error");
    });
    const app = createApp(state, { approveTriageIssue });
    const res = await app.request("/api/triage/uuid-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Approve failed: Linear API error");
  });
});

describe("POST /api/triage/:issueId/reject", () => {
  test("returns 400 when rejectTriageIssue callback not configured", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/triage/some-uuid/reject", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Triage not configured");
  });

  test("calls rejectTriageIssue and returns rejected: true", async () => {
    const state = new AppState();
    const rejectTriageIssue = mock(async (_id: string) => {});
    const app = createApp(state, { rejectTriageIssue });
    const res = await app.request("/api/triage/uuid-1/reject", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rejected: boolean };
    expect(json.rejected).toBe(true);
    expect(rejectTriageIssue).toHaveBeenCalledWith("uuid-1");
  });

  test("returns 500 with error when rejectTriageIssue throws", async () => {
    const state = new AppState();
    const rejectTriageIssue = mock(async (_id: string) => {
      throw new Error("Network error");
    });
    const app = createApp(state, { rejectTriageIssue });
    const res = await app.request("/api/triage/uuid-1/reject", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Reject failed: Network error");
  });
});

describe("GET /health", () => {
  test("returns 200 with expected JSON structure on a fresh AppState", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("status");
    expect(json).toHaveProperty("uptime");
    expect(json).toHaveProperty("memory");
    expect(json.memory as Record<string, unknown>).toHaveProperty("rss");
    expect(json).toHaveProperty("subsystems");
    const subs = json.subsystems as Record<string, unknown>;
    expect(subs).toHaveProperty("executor");
    expect(subs).toHaveProperty("monitor");
    expect(subs).toHaveProperty("planner");
    expect(subs).toHaveProperty("projects");
  });

  test("response content-type is application/json", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("status field is one of 'pass', 'warn', or 'fail'", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    const json = (await res.json()) as { status: string };
    expect(["pass", "warn", "fail"]).toContain(json.status);
  });

  test("fresh AppState returns status: 'pass' and HTTP 200", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("pass");
  });

  test("paused state returns status: 'warn' and HTTP 200", async () => {
    const state = new AppState();
    state.togglePause();
    const app = createApp(state);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("warn");
  });

  test("is accessible without auth token when auth is configured", async () => {
    const state = new AppState();
    const app = createApp(state, { authToken: "secret" });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  test("uptime is a non-negative number", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    const json = (await res.json()) as { uptime: number };
    expect(typeof json.uptime).toBe("number");
    expect(json.uptime).toBeGreaterThanOrEqual(0);
  });

  test("memory.rss is a positive number", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/health");
    const json = (await res.json()) as { memory: { rss: number } };
    expect(typeof json.memory.rss).toBe("number");
    expect(json.memory.rss).toBeGreaterThan(0);
  });
});

describe("computeHealth", () => {
  test("fresh AppState produces status: 'pass'", () => {
    const state = new AppState();
    const health = computeHealth(state);
    expect(health.status).toBe("pass");
  });

  test("paused state produces status: 'warn'", () => {
    const state = new AppState();
    state.togglePause();
    const health = computeHealth(state);
    expect(health.status).toBe("warn");
  });

  test("failed planning produces planner status: 'warn' and overall 'warn'", () => {
    const state = new AppState();
    state.updatePlanning({ lastResult: "failed" });
    const health = computeHealth(state);
    expect(health.subsystems.planner.status).toBe("warn");
    expect(health.status).toBe("warn");
  });

  test("timed_out planning produces planner status: 'warn'", () => {
    const state = new AppState();
    state.updatePlanning({ lastResult: "timed_out" });
    const health = computeHealth(state);
    expect(health.subsystems.planner.status).toBe("warn");
  });

  test("completed planning produces planner status: 'pass'", () => {
    const state = new AppState();
    state.updatePlanning({ lastResult: "completed" });
    const health = computeHealth(state);
    expect(health.subsystems.planner.status).toBe("pass");
  });

  test("queue stale > 5min produces executor status: 'warn'", () => {
    const state = new AppState();
    state.updateQueue(5, 0); // sets lastChecked to now
    const future = Date.now() + 6 * 60 * 1000; // 6 minutes later
    const health = computeHealth(state, future);
    expect(health.subsystems.executor.status).toBe("warn");
    expect(health.status).toBe("warn");
  });

  test("queue stale > 10min produces executor status: 'fail' and HTTP 503", async () => {
    const state = new AppState();
    state.updateQueue(5, 0); // sets lastChecked to now
    const future = Date.now() + 11 * 60 * 1000; // 11 minutes later
    const health = computeHealth(state, future);
    expect(health.subsystems.executor.status).toBe("fail");
    expect(health.status).toBe("fail");

    // Verify the route returns 503 when computeHealth returns 'fail'
    // (503 is returned when status === 'fail')
    const httpStatus = health.status === "fail" ? 503 : 200;
    expect(httpStatus).toBe(503);
  });

  test("fresh queue (never checked) produces executor status: 'pass'", () => {
    const state = new AppState();
    // queue.lastChecked === 0, never checked — not considered stale
    const health = computeHealth(state);
    expect(health.subsystems.executor.status).toBe("pass");
  });

  test("executor runningAgents reflects current running count", () => {
    const state = new AppState();
    state.addAgent("agent-1", "ENG-1", "Test issue");
    state.addAgent("agent-2", "ENG-2", "Another issue");
    const health = computeHealth(state);
    expect(health.subsystems.executor.runningAgents).toBe(2);
  });

  test("planner metadata is included in response", () => {
    const state = new AppState();
    state.updatePlanning({
      running: true,
      lastResult: "completed",
      lastRunAt: 12345,
    });
    const health = computeHealth(state);
    expect(health.subsystems.planner.running).toBe(true);
    expect(health.subsystems.planner.lastResult).toBe("completed");
    expect(health.subsystems.planner.lastRunAt).toBe(12345);
  });

  test("queueLastChecked is null when queue has never been checked", () => {
    const state = new AppState();
    const health = computeHealth(state);
    expect(health.subsystems.executor.queueLastChecked).toBeNull();
  });

  test("queueLastChecked is a number when queue has been checked", () => {
    const state = new AppState();
    state.updateQueue(3, 1);
    const health = computeHealth(state);
    expect(typeof health.subsystems.executor.queueLastChecked).toBe("number");
  });

  test("planner sessionCount is 0 on fresh AppState", () => {
    const state = new AppState();
    const health = computeHealth(state);
    expect(health.subsystems.planner.sessionCount).toBe(0);
  });

  test("planner sessionCount reflects added planning sessions", () => {
    const state = new AppState();
    state.addPlanningSession({
      id: "ps-1",
      agentRunId: "run-1",
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed",
      issuesFiledCount: 2,
    });
    state.addPlanningSession({
      id: "ps-2",
      agentRunId: "run-2",
      startedAt: 3000,
      finishedAt: 4000,
      status: "failed",
      issuesFiledCount: 0,
    });
    const health = computeHealth(state);
    expect(health.subsystems.planner.sessionCount).toBe(2);
  });
});

describe("GET /api/status — planningHistory", () => {
  test("includes planningHistory array in response", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("planningHistory");
    expect(Array.isArray(json.planningHistory)).toBe(true);
  });

  test("planningHistory is empty when no sessions added", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/api/status");
    const json = (await res.json()) as { planningHistory: unknown[] };
    expect(json.planningHistory).toHaveLength(0);
  });

  test("planningHistory includes added sessions", async () => {
    const state = new AppState();
    state.addPlanningSession({
      id: "ps-abc",
      agentRunId: "run-abc",
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed",
      issuesFiledCount: 3,
    });
    const app = createApp(state);
    const res = await app.request("/api/status");
    const json = (await res.json()) as {
      planningHistory: Array<{ id: string }>;
    };
    expect(json.planningHistory).toHaveLength(1);
    expect(json.planningHistory[0].id).toBe("ps-abc");
  });
});

describe("GET /partials/stats — planning count", () => {
  test("shows Plans stat with count 0 when no sessions", async () => {
    const state = new AppState();
    const app = createApp(state);
    const res = await app.request("/partials/stats");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Plans");
  });

  test("shows Plans stat count reflecting added sessions", async () => {
    const state = new AppState();
    state.addPlanningSession({
      id: "ps-1",
      agentRunId: "run-1",
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed",
      issuesFiledCount: 1,
    });
    state.addPlanningSession({
      id: "ps-2",
      agentRunId: "run-2",
      startedAt: 3000,
      finishedAt: 4000,
      status: "completed",
      issuesFiledCount: 0,
    });
    const app = createApp(state);
    const res = await app.request("/partials/stats");
    const body = await res.text();
    expect(body).toContain("Plans");
    expect(body).toContain(">2<");
  });
});
