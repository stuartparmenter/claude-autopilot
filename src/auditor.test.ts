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
      throw new Error("unexpected fetchNext in auditor tests");
    },
  };
});

import { runAudit, shouldRunAudit } from "./auditor";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
// NOTE: We inject a mock LinearClient via setClientForTesting instead of
// mocking ./lib/linear as a module, to avoid Bun 1.3.9 mock/restore
// cross-file interference (same pattern as linear.test.ts and monitor.test.ts).
// NOTE: We intentionally do NOT mock ./lib/prompt — the real buildAuditorPrompt
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

function makeConfig(skipTriage = true): AutopilotConfig {
  return {
    linear: {
      team: "ENG",
      project: "test-project",
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
      planning_model: "opus",
      max_retries: 3,
      poll_interval_minutes: 5,
    },
    auditor: {
      schedule: "when_idle",
      min_ready_threshold: 5,
      min_interval_minutes: 60,
      max_issues_per_run: 10,
      use_agent_teams: false,
      skip_triage: skipTriage,
      scan_dimensions: [],
      brainstorm_features: true,
      brainstorm_dimensions: [],
      max_ideas_per_run: 5,
    },
    github: { repo: "", automerge: false },
    project: { name: "test-project" },
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
    projectId: "project-id",
    projectName: "test-project",
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
// shouldRunAudit — schedule checks
// ---------------------------------------------------------------------------

describe("shouldRunAudit — schedule checks", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when schedule === 'manual'", async () => {
    const config = makeConfig();
    config.auditor.schedule = "manual";
    mockIssues.mockClear();

    const result = await shouldRunAudit({
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
// shouldRunAudit — backlog threshold
// ---------------------------------------------------------------------------

describe("shouldRunAudit — backlog threshold", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when backlog >= threshold (exactly at threshold)", async () => {
    // readyCount=3, triageCount=2 → backlog=5, threshold=5 → false
    issueNodeCounts = [3, 2];

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("returns true when backlog < threshold", async () => {
    // readyCount=2, triageCount=1 → backlog=3, threshold=5 → true
    issueNodeCounts = [2, 1];

    const result = await shouldRunAudit({
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
    await shouldRunAudit({
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
// shouldRunAudit — min interval check
// ---------------------------------------------------------------------------

describe("shouldRunAudit — min interval check", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when lastRunAt is within the interval", async () => {
    // Set lastRunAt to 30 minutes ago, interval is 60 minutes
    state.updateAuditor({ lastRunAt: Date.now() - 30 * 60 * 1000 });
    // Backlog is low so threshold check would pass
    issueNodeCounts = [0, 0];

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
    // Should short-circuit before making any API calls
    expect(mockIssues.mock.calls).toHaveLength(0);
  });

  test("returns true when lastRunAt is older than the interval and backlog is low", async () => {
    // Set lastRunAt to 90 minutes ago, interval is 60 minutes
    state.updateAuditor({ lastRunAt: Date.now() - 90 * 60 * 1000 });
    // Backlog is low so threshold check passes
    issueNodeCounts = [0, 0];

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("returns true when lastRunAt is undefined (first run) and backlog is low", async () => {
    // No lastRunAt set — first run
    issueNodeCounts = [0, 0];

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("returns false when lastRunAt is within interval even if backlog is below threshold", async () => {
    const config = makeConfig();
    config.auditor.min_interval_minutes = 120;
    // Set lastRunAt to 60 minutes ago — within 120 minute interval
    state.updateAuditor({ lastRunAt: Date.now() - 60 * 60 * 1000 });
    issueNodeCounts = [0, 0];

    const result = await shouldRunAudit({
      config,
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAudit — success path
// ---------------------------------------------------------------------------

describe("runAudit — success path", () => {
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
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].status).toBe("completed");
  });

  test("records cost in completion metadata", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].costUsd).toBe(0.5);
  });

  test("updates auditor status: running=false, lastResult='completed'", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const auditor = state.getAuditorStatus();
    expect(auditor.running).toBe(false);
    expect(auditor.lastResult).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// runAudit — timeout path
// ---------------------------------------------------------------------------

describe("runAudit — timeout path", () => {
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
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().lastResult).toBe("timed_out");
  });

  test("sets running to false after timeout", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAudit — error path
// ---------------------------------------------------------------------------

describe("runAudit — error path", () => {
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
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().lastResult).toBe("failed");
  });

  test("sets running to false after error", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAudit — thrown exception path
// ---------------------------------------------------------------------------

describe("runAudit — thrown exception path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockRejectedValue(new Error("runClaude unexpected crash"));
  });

  test("sets running to false when runClaude throws", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().running).toBe(false);
  });

  test("sets lastResult to 'failed' when runClaude throws", async () => {
    await runAudit({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getAuditorStatus().lastResult).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// runAudit — skip_triage config
// ---------------------------------------------------------------------------

describe("runAudit — skip_triage config", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 1000,
      numTurns: 3,
      result: "",
    });
  });

  test("uses ready state name in prompt when skip_triage=true", async () => {
    mockRunClaude.mockClear();

    await runAudit({
      config: makeConfig(true),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const calls = mockRunClaude.mock.calls as unknown as Array<
      [{ prompt: string }]
    >;
    expect(calls[0][0].prompt).toContain("ready-id");
  });

  test("uses triage state name in prompt when skip_triage=false", async () => {
    mockRunClaude.mockClear();

    await runAudit({
      config: makeConfig(false),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const calls = mockRunClaude.mock.calls as unknown as Array<
      [{ prompt: string }]
    >;
    expect(calls[0][0].prompt).toContain("triage-id");
  });
});
