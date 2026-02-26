import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { ClaudeResult } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import {
  resetClient as resetLinearClient,
  setClientForTesting,
} from "./lib/linear";
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

// Queue of node counts to return for sequential countIssuesInState calls.
// Inject via setClientForTesting to avoid mock.module("./lib/linear") which
// causes Bun 1.3.9 mock/restore cross-file interference.
let issueNodeCounts: number[] = [];
const mockIssues = mock(async () => {
  const count = issueNodeCounts.shift() ?? 0;
  return {
    nodes: Array.from({ length: count }, (_, i) => ({ id: `issue-${i}` })),
    pageInfo: { hasNextPage: false },
    fetchNext: async () => {
      throw new Error("unexpected fetchNext in planner tests");
    },
  };
});

import { runPlanning, shouldRunPlanning } from "./planner";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
// NOTE: We inject a mock LinearClient via setClientForTesting instead of
// mocking ./lib/linear as a module, to avoid Bun 1.3.9 mock/restore
// cross-file interference (same pattern as linear.test.ts and monitor.test.ts).
// NOTE: We intentionally do NOT mock ./lib/prompt — the real buildCTOPrompt
// reads from prompts/ on disk and doesn't leak across test files.
beforeEach(() => {
  issueNodeCounts = [];
  mockIssues.mockClear();
  setClientForTesting({ issues: mockIssues } as unknown as LinearClient);
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
});

afterEach(() => {
  mock.restore();
  resetLinearClient();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AutopilotConfig {
  return {
    linear: {
      team: "ENG",
      initiative: "",
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
    },
    planning: {
      schedule: "when_idle",
      min_ready_threshold: 5,
      min_interval_minutes: 60,
      max_issues_per_run: 5,
      timeout_minutes: 90,
      model: "opus",
    },
    projects: {
      enabled: true,
      poll_interval_minutes: 10,
      max_active_projects: 5,
      timeout_minutes: 60,
      model: "opus",
    },
    monitor: {
      respond_to_reviews: false,
      review_responder_timeout_minutes: 20,
    },
    github: { repo: "", automerge: false },
    persistence: {
      enabled: true,
      db_path: ".claude/autopilot.db",
      retention_days: 30,
    },
    sandbox: {
      enabled: true,
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

// ---------------------------------------------------------------------------
// shouldRunPlanning — schedule checks
// ---------------------------------------------------------------------------

describe("shouldRunPlanning — schedule checks", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when schedule === 'manual'", async () => {
    const config = makeConfig();
    config.planning.schedule = "manual";
    mockIssues.mockClear();

    const result = await shouldRunPlanning({
      config,
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
    // Short-circuits before any API call
    expect(mockIssues.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldRunPlanning — backlog threshold
// ---------------------------------------------------------------------------

describe("shouldRunPlanning — backlog threshold", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when backlog >= threshold (exactly at threshold)", async () => {
    // readyCount=3, triageCount=2 → backlog=5, threshold=5 → false
    issueNodeCounts = [3, 2];

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("returns true when backlog < threshold", async () => {
    // readyCount=2, triageCount=1 → backlog=3, threshold=5 → true
    issueNodeCounts = [2, 1];

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("calls countIssuesInState with ready and triage state IDs", async () => {
    mockIssues.mockClear();
    // issueNodeCounts stays empty — mockIssues defaults to 0 nodes per call

    const linearIds = makeLinearIds();
    await shouldRunPlanning({
      config: makeConfig(),
      linearIds,
      state,
    });

    // Verify the state IDs queried via the LinearClient filter
    const calledStateIds = mockIssues.mock.calls.map(
      (call: unknown[]) =>
        (call[0] as { filter: { state: { id: { eq: string } } } })?.filter
          ?.state?.id?.eq,
    );
    expect(calledStateIds).toContain("ready-id");
    expect(calledStateIds).toContain("triage-id");
  });
});

// ---------------------------------------------------------------------------
// runPlanning — success path
// ---------------------------------------------------------------------------

describe("runPlanning — success path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
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
  });

  test("completes agent as 'completed' in state", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].status).toBe("completed");
  });

  test("records cost in completion metadata", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].costUsd).toBe(0.5);
  });

  test("updates planning status: running=false, lastResult='completed'", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const planning = state.getPlanningStatus();
    expect(planning.running).toBe(false);
    expect(planning.lastResult).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// runPlanning — timeout path
// ---------------------------------------------------------------------------

describe("runPlanning — timeout path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: true,
      inactivityTimedOut: false,
      error: "Timed out",
      costUsd: undefined,
      durationMs: 3600000,
      numTurns: 10,
      result: "",
    });
  });

  test("sets lastResult to 'timed_out'", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getPlanningStatus().lastResult).toBe("timed_out");
  });

  test("sets running to false after timeout", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getPlanningStatus().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPlanning — error path
// ---------------------------------------------------------------------------

describe("runPlanning — error path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: "Claude crashed",
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });
  });

  test("sets lastResult to 'failed'", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getPlanningStatus().lastResult).toBe("failed");
  });

  test("sets running to false after error", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getPlanningStatus().running).toBe(false);
  });
});
