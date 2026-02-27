import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { ClaudeResult } from "./lib/claude";
import * as _realClaude from "./lib/claude";

// Snapshot of real claude module exports, captured before any mock.module()
// calls. Used in afterAll to restore the module for subsequent test files,
// because mock.restore() does not undo mock.module() in Bun 1.3.9.
const _realClaudeSnapshot = { ..._realClaude };

import type { AutopilotConfig, LinearIds } from "./lib/config";
import {
  getUnreviewedRuns,
  insertAgentRun,
  markRunsReviewed,
  openDb,
} from "./lib/db";
import { AppState } from "./state";

// ---------------------------------------------------------------------------
// Mock functions — created once, re-wired per test via beforeEach
// ---------------------------------------------------------------------------

const mockRunClaude = mock(
  (): Promise<ClaudeResult> =>
    Promise.resolve({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 1000,
      numTurns: 3,
      result: "",
      sessionId: undefined,
    }),
);

import { runReviewer, shouldRunReviewer } from "./reviewer";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
beforeEach(() => {
  mockRunClaude.mockClear();
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
});

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  reviewerOverrides: Partial<AutopilotConfig["reviewer"]> = {},
): AutopilotConfig {
  return {
    linear: {
      team: "ENG",
      initiative: "",
      labels: [],
      projects: [],
      states: {
        triage: "triage-id",
        ready: "ready-id",
        in_progress: "in-progress-id",
        in_review: "in-review-id",
        done: "done-id",
        blocked: "blocked-id",
      },
    },
    executor: {
      parallel: 3,
      timeout_minutes: 30,
      fixer_timeout_minutes: 20,
      max_fixer_attempts: 3,
      inactivity_timeout_minutes: 10,
      auto_approve_labels: [],
      branch_pattern: "autopilot/{{id}}",
      commit_pattern: "{{id}}: {{title}}",
      model: "sonnet",
      max_retries: 3,
      poll_interval_minutes: 5,
      stale_timeout_minutes: 15,
    },
    planning: {
      schedule: "when_idle",
      min_ready_threshold: 5,
      min_interval_minutes: 60,
      max_issues_per_run: 5,
      timeout_minutes: 90,
      inactivity_timeout_minutes: 30,
      model: "opus",
    },
    projects: {
      enabled: true,
      poll_interval_minutes: 10,
      backlog_review_interval_minutes: 240,
      max_active_projects: 5,
      timeout_minutes: 60,
      model: "opus",
    },
    reviewer: {
      enabled: true,
      min_interval_minutes: 60,
      min_runs_before_review: 3,
      timeout_minutes: 60,
      model: "opus",
      max_issues_per_review: 5,
      ...reviewerOverrides,
    },
    monitor: {
      respond_to_reviews: false,
      review_responder_timeout_minutes: 20,
    },
    github: { repo: "", automerge: false },
    git: {
      user_name: "autopilot[bot]",
      user_email: "autopilot[bot]@users.noreply.github.com",
    },
    persistence: {
      enabled: true,
      db_path: ".claude/autopilot.db",
      retention_days: 30,
    },
    sandbox: {
      enabled: false,
      auto_allow_bash: true,
      network_restricted: false,
      extra_allowed_domains: [],
    },
    budget: {
      daily_limit_usd: 0,
      monthly_limit_usd: 0,
      per_agent_limit_usd: 0,
      warn_at_percent: 80,
    },
  };
}

function makeLinearIds(): LinearIds {
  return {
    teamId: "team-id",
    teamKey: "ENG",
    states: {
      triage: "triage-id",
      ready: "ready-id",
      in_progress: "in-progress-id",
      in_review: "in-review-id",
      done: "done-id",
      blocked: "blocked-id",
    },
  };
}

async function insertRuns(
  db: ReturnType<typeof openDb>,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertAgentRun(db, {
      id: `run-${i}`,
      issueId: `ENG-${i}`,
      issueTitle: `Test Issue ${i}`,
      status: "completed",
      startedAt: 1000 + i * 1000,
      finishedAt: 2000 + i * 1000,
    });
  }
}

// ---------------------------------------------------------------------------
// shouldRunReviewer
// ---------------------------------------------------------------------------

describe("shouldRunReviewer — enabled check", () => {
  test("returns false when enabled === false", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 5);

    const result = await shouldRunReviewer({
      config: makeConfig({ enabled: false }),
      state,
      db,
    });

    expect(result).toBe(false);
    db.close();
  });
});

describe("shouldRunReviewer — already running", () => {
  test("returns false when reviewer is already running", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    state.updateReviewer({ running: true });
    await insertRuns(db, 5);

    const result = await shouldRunReviewer({
      config: makeConfig(),
      state,
      db,
    });

    expect(result).toBe(false);
    db.close();
  });
});

describe("shouldRunReviewer — min interval", () => {
  test("returns false when last run is within interval", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    // Set lastRunAt to 30 minutes ago; interval is 60 minutes
    state.updateReviewer({ lastRunAt: Date.now() - 30 * 60 * 1000 });
    await insertRuns(db, 5);

    const result = await shouldRunReviewer({
      config: makeConfig({ min_interval_minutes: 60 }),
      state,
      db,
    });

    expect(result).toBe(false);
    db.close();
  });

  test("returns true when last run is older than interval and enough runs", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    // Set lastRunAt to 90 minutes ago; interval is 60 minutes
    state.updateReviewer({ lastRunAt: Date.now() - 90 * 60 * 1000 });
    await insertRuns(db, 5);

    const result = await shouldRunReviewer({
      config: makeConfig({
        min_interval_minutes: 60,
        min_runs_before_review: 3,
      }),
      state,
      db,
    });

    expect(result).toBe(true);
    db.close();
  });
});

describe("shouldRunReviewer — min runs threshold", () => {
  test("returns false when unreviewed run count < threshold", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    // Only 2 runs, threshold is 3
    await insertRuns(db, 2);

    const result = await shouldRunReviewer({
      config: makeConfig({ min_runs_before_review: 3 }),
      state,
      db,
    });

    expect(result).toBe(false);
    db.close();
  });

  test("returns true when unreviewed runs >= threshold and no interval constraint", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    // 5 runs, threshold is 3
    await insertRuns(db, 5);

    const result = await shouldRunReviewer({
      config: makeConfig({ min_runs_before_review: 3 }),
      state,
      db,
    });

    expect(result).toBe(true);
    db.close();
  });

  test("already-reviewed runs do not count toward threshold", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    // Insert 5 runs but mark them all reviewed
    await insertRuns(db, 5);
    await markRunsReviewed(db, ["run-0", "run-1", "run-2", "run-3", "run-4"]);

    const result = await shouldRunReviewer({
      config: makeConfig({ min_runs_before_review: 3 }),
      state,
      db,
    });

    expect(result).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runReviewer — success path
// ---------------------------------------------------------------------------

describe("runReviewer — success path", () => {
  test("marks queried runs as reviewed after agent completes", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 5);

    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.5,
      durationMs: 2000,
      numTurns: 5,
      result: "done",
      sessionId: "sess-1",
    });

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    // All runs should be marked as reviewed now
    const unreviewedAfter = getUnreviewedRuns(db);
    expect(unreviewedAfter).toHaveLength(0);
    db.close();
  });

  test("updates reviewer status: running=false, lastResult='completed'", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 3);

    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 1000,
      numTurns: 2,
      result: "done",
    });

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    const reviewerStatus = state.getReviewerStatus();
    expect(reviewerStatus.running).toBe(false);
    expect(reviewerStatus.lastResult).toBe("completed");
    expect(reviewerStatus.lastRunAt).toBeDefined();
    db.close();
  });

  test("calls runClaude with a prompt containing run summaries", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 3);

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    expect(mockRunClaude.mock.calls).toHaveLength(1);
    const firstCall = mockRunClaude.mock.calls[0] as unknown as [
      { prompt: string; label: string },
    ];
    const callOpts = firstCall[0];
    expect(callOpts.label).toBe("reviewer");
    // Prompt should contain run IDs
    expect(callOpts.prompt).toContain("run-0");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runReviewer — failure path (agent returns error)
// ---------------------------------------------------------------------------

describe("runReviewer — failure path (agent returns error)", () => {
  test("still marks runs as reviewed even when agent fails", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 5);

    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: "Agent failed",
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    // Runs should still be marked reviewed to prevent infinite loop
    const unreviewedAfter = getUnreviewedRuns(db);
    expect(unreviewedAfter).toHaveLength(0);
    db.close();
  });

  test("sets lastResult to 'failed' when agent fails", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 3);

    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: "Agent failed",
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    expect(state.getReviewerStatus().lastResult).toBe("failed");
    expect(state.getReviewerStatus().running).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runReviewer — crash path (runClaude rejects)
// ---------------------------------------------------------------------------

describe("runReviewer — crash path (runClaude rejects)", () => {
  test("marks runs reviewed and sets running=false when runClaude throws", async () => {
    const db = openDb(":memory:");
    const state = new AppState();
    await insertRuns(db, 3);

    mockRunClaude.mockRejectedValue(new Error("boom"));

    await runReviewer({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
      db,
    });

    expect(state.getReviewerStatus().running).toBe(false);
    expect(state.getReviewerStatus().lastResult).toBe("failed");
    // Runs should still be marked reviewed
    expect(getUnreviewedRuns(db)).toHaveLength(0);
    db.close();
  });
});

// Restore the real claude module after all tests in this file so the mock
// doesn't leak into subsequent test files. mock.restore() does NOT undo
// mock.module() calls in Bun 1.3.9, so we must do this explicitly.
afterAll(() => {
  mock.module("./lib/claude", () => ({
    ..._realClaudeSnapshot,
  }));
});
