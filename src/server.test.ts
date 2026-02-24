import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createApp, escapeHtml, formatDuration } from "./server";
import { AppState } from "./state";

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

  test("single quote is intentionally NOT escaped", () => {
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });

  test("escapes all four entities in one string", () => {
    expect(escapeHtml('<a href="x">a & b</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;a &amp; b&lt;/a&gt;",
    );
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
    expect(body).toContain("claude-autopilot");
  });

  test("GET /api/status returns JSON with expected keys", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("paused");
    expect(json).toHaveProperty("agents");
    expect(json).toHaveProperty("history");
    expect(json).toHaveProperty("queue");
    expect(json).toHaveProperty("auditor");
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

describe("POST /api/audit", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("returns 409 when audit is already running", async () => {
    state.updateAuditor({ running: true });
    const res = await app.request("/api/audit", { method: "POST" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Audit already running");
  });

  test("triggers audit and returns triggered: true when not running", async () => {
    const triggerAudit = mock(() => {});
    const appWithActions = createApp(state, { triggerAudit });
    const res = await appWithActions.request("/api/audit", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(true);
    expect(triggerAudit).toHaveBeenCalledTimes(1);
  });

  test("returns triggered: true even without actions configured", async () => {
    const res = await app.request("/api/audit", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { triggered: boolean };
    expect(json.triggered).toBe(true);
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
});

describe("GET /partials/audit-button", () => {
  let state: AppState;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    state = new AppState();
    app = createApp(state);
  });

  test("shows 'Trigger Audit' when auditor is not running", async () => {
    const res = await app.request("/partials/audit-button");
    const body = await res.text();
    expect(body).toContain("Trigger Audit");
  });

  test("shows 'Auditing...' and disabled when auditor is running", async () => {
    state.updateAuditor({ running: true });
    const res = await app.request("/partials/audit-button");
    const body = await res.text();
    expect(body).toContain("Auditing...");
    expect(body).toContain("disabled");
  });
});
