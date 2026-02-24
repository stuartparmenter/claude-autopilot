import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeResult } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
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

const mockCountIssuesInState = mock(
  (_linearIds: LinearIds, _stateId: string): Promise<number> =>
    Promise.resolve(0),
);

import { runAudit, shouldRunAudit } from "./auditor";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
// NOTE: We intentionally do NOT mock ./lib/prompt — the real buildAuditorPrompt
// reads from prompts/ on disk and doesn't leak across test files.
beforeEach(() => {
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
  mock.module("./lib/linear", () => ({
    countIssuesInState: mockCountIssuesInState,
  }));
});

afterEach(() => mock.restore());

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
    mockCountIssuesInState.mockClear();

    const result = await shouldRunAudit({
      config,
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
    // Short-circuits before any API call
    expect(mockCountIssuesInState.mock.calls).toHaveLength(0);
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
    mockCountIssuesInState.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("returns true when backlog < threshold", async () => {
    // readyCount=2, triageCount=1 → backlog=3, threshold=5 → true
    mockCountIssuesInState.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const result = await shouldRunAudit({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("calls countIssuesInState with ready and triage state IDs", async () => {
    mockCountIssuesInState.mockClear();
    mockCountIssuesInState.mockResolvedValue(0);

    const linearIds = makeLinearIds();
    await shouldRunAudit({
      config: makeConfig(),
      linearIds,
      state,
    });

    const calledStateIds = mockCountIssuesInState.mock.calls.map(
      (call) => call[1],
    );
    expect(calledStateIds).toContain("ready-id");
    expect(calledStateIds).toContain("triage-id");
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
