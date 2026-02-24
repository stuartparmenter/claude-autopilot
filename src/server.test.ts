import { beforeEach, describe, expect, test } from "bun:test";
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

  test("escapes single quote", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  test("escapes all five entities in one string", () => {
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
