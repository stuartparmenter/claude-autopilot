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
const mockUpdateIssue = mock(
  (_issueId: string, _opts: { stateId?: string; comment?: string }) =>
    Promise.resolve(),
);
const mockGetReadyIssues = mock(
  (
    _linearIds: LinearIds,
    _limit?: number,
  ): Promise<Array<{ id: string; identifier: string; title: string }>> =>
    Promise.resolve([]),
);

import { executeIssue, fillSlots } from "./executor";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
// NOTE: We intentionally do NOT mock ./lib/prompt — the real buildPrompt
// reads from prompts/ on disk and doesn't leak across test files.
beforeEach(() => {
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
  mock.module("./lib/linear", () => ({
    updateIssue: mockUpdateIssue,
    getReadyIssues: mockGetReadyIssues,
    validateIdentifier: () => {},
  }));
});

afterEach(() => mock.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(parallelSlots = 3): AutopilotConfig {
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
      parallel: parallelSlots,
      timeout_minutes: 30,
      max_retries: 3,
      inactivity_timeout_minutes: 10,
      poll_interval_minutes: 5,
      auto_approve_labels: [],
      branch_pattern: "autopilot/{{id}}",
      commit_pattern: "{{id}}: {{title}}",
      model: "sonnet",
      planning_model: "opus",
    },
    auditor: {
      schedule: "when_idle",
      min_ready_threshold: 5,
      max_issues_per_run: 10,
      use_agent_teams: false,
      skip_triage: true,
      scan_dimensions: [],
      brainstorm_features: true,
      brainstorm_dimensions: [],
      max_ideas_per_run: 5,
    },
    github: { repo: "", automerge: false },
    project: { name: "test-project" },
    persistence: { enabled: false, db_path: ".claude/autopilot.db" },
    sandbox: {
      enabled: true,
      auto_allow_bash: true,
      network_restricted: false,
      extra_allowed_domains: [],
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

// Use a counter to generate unique IDs so module-scoped activeIssueIds
// doesn't accumulate across tests
let testCounter = 0;
function makeIssue() {
  testCounter++;
  return {
    id: `issue-${testCounter}`,
    identifier: `ENG-${testCounter}`,
    title: `Test Issue ${testCounter}`,
  };
}

// ---------------------------------------------------------------------------
// executeIssue
// ---------------------------------------------------------------------------

describe("executeIssue — success path", () => {
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
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("returns true on success", async () => {
    const result = await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("moves issue to in_progress before running Claude", async () => {
    mockUpdateIssue.mockClear();

    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const firstCall = mockUpdateIssue.mock.calls[0];
    expect(firstCall[1]).toMatchObject({ stateId: "in-progress-id" });
  });

  test("completes agent as 'completed' in state", async () => {
    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const history = state.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
  });

  test("clears activeIssueIds after success (finally block)", async () => {
    const issue = makeIssue();

    await executeIssue({
      issue,
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // If activeIssueIds retained the ID, a subsequent fillSlots would filter it.
    // We verify by checking that fillSlots can pick it up again.
    mockGetReadyIssues.mockResolvedValue([issue]);
    const promises = await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state: new AppState(),
    });
    // If the ID were still in activeIssueIds it would be filtered → 0 promises
    expect(promises).toHaveLength(1);
  });
});

describe("executeIssue — timeout path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: true,
      inactivityTimedOut: false,
      error: "Timed out",
      costUsd: undefined,
      durationMs: 1800000,
      numTurns: 10,
      result: "",
    });
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("returns false on timeout", async () => {
    const result = await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("moves issue to blocked state on timeout", async () => {
    mockUpdateIssue.mockClear();
    const issue = makeIssue();

    await executeIssue({
      issue,
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const blockedCall = mockUpdateIssue.mock.calls.find(
      (call) => call[1]?.stateId === "blocked-id",
    );
    expect(blockedCall).toBeDefined();
  });

  test("timeout comment includes timeout_minutes", async () => {
    mockUpdateIssue.mockClear();

    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const blockedCall = mockUpdateIssue.mock.calls.find(
      (call) => call[1]?.stateId === "blocked-id",
    );
    expect(blockedCall?.[1]?.comment).toContain("30");
  });

  test("completes agent as 'timed_out' in state", async () => {
    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].status).toBe("timed_out");
  });
});

describe("executeIssue — error path", () => {
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
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("returns false on error", async () => {
    const result = await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("moves issue back to ready on error (for retry)", async () => {
    mockUpdateIssue.mockClear();

    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const readyCall = mockUpdateIssue.mock.calls.find(
      (call) => call[1]?.stateId === "ready-id",
    );
    expect(readyCall).toBeDefined();
  });

  test("completes agent as 'failed' in state", async () => {
    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getHistory()[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// fillSlots
// ---------------------------------------------------------------------------

describe("fillSlots", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockGetReadyIssues.mockResolvedValue([]);
    mockUpdateIssue.mockResolvedValue(undefined);
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });
  });

  test("returns empty array when all slots are full", async () => {
    state.addAgent("a1", "ENG-100", "Test 1");
    state.addAgent("a2", "ENG-101", "Test 2");
    state.addAgent("a3", "ENG-102", "Test 3");

    const promises = await fillSlots({
      config: makeConfig(3),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(promises).toHaveLength(0);
  });

  test("returns empty array when no ready issues", async () => {
    mockGetReadyIssues.mockResolvedValue([]);

    const promises = await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(promises).toHaveLength(0);
  });

  test("returns one promise per ready issue", async () => {
    const issues = [makeIssue(), makeIssue()];
    mockGetReadyIssues.mockResolvedValue(issues);

    const promises = await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(promises).toHaveLength(2);
  });

  test("calls updateQueue with issue count and running count", async () => {
    state.addAgent("running-1", "ENG-999", "running");
    mockGetReadyIssues.mockResolvedValue([makeIssue(), makeIssue()]);

    await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const snap = state.toJSON();
    expect(snap.queue.readyCount).toBe(2);
    expect(snap.queue.inProgressCount).toBe(1);
  });

  test("fetches available+activeSize issues from Linear", async () => {
    mockGetReadyIssues.mockClear();
    mockGetReadyIssues.mockResolvedValue([]);
    await fillSlots({
      config: makeConfig(3),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const calledWith = mockGetReadyIssues.mock.calls[0];
    expect(calledWith[1]).toBeGreaterThanOrEqual(3);
  });

  test("filters out issues already being executed", async () => {
    const activeIssue = makeIssue();
    const freshIssue = makeIssue();

    const hangingRunClaude = new Promise<
      typeof mockRunClaude extends (...args: any[]) => Promise<infer R>
        ? R
        : never
    >((resolve) => {
      setTimeout(
        () =>
          resolve({
            timedOut: false,
            inactivityTimedOut: false,
            error: undefined,
            costUsd: 0,
            durationMs: 0,
            numTurns: 0,
            result: "",
          }),
        10000,
      );
    });
    mockRunClaude.mockReturnValue(hangingRunClaude as any);

    const execPromise = executeIssue({
      issue: activeIssue,
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 100,
      numTurns: 1,
      result: "",
    });

    mockGetReadyIssues.mockResolvedValue([activeIssue, freshIssue]);

    const promises = await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(promises).toHaveLength(1);

    await Promise.allSettled([...promises.map((p) => p), execPromise]);
  });
});
