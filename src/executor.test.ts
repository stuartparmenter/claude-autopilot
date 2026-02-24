import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeResult } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { AppState } from "./state";

// Mock modules BEFORE importing the module under test
const mockRunClaude = mock(
  (): Promise<ClaudeResult> =>
    Promise.resolve({
      timedOut: false,
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
const mockBuildPrompt = mock(() => "mock-executor-prompt");

mock.module("./lib/claude", () => ({ runClaude: mockRunClaude }));
mock.module("./lib/linear", () => ({
  updateIssue: mockUpdateIssue,
  getReadyIssues: mockGetReadyIssues,
}));
mock.module("./lib/prompt", () => ({ buildPrompt: mockBuildPrompt }));

import { executeIssue, fillSlots } from "./executor";

// Restore all module mocks after this file so other test files are not affected
afterAll(() => mock.restore());

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
    },
    github: { repo: "" },
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

  test("calls buildPrompt with 'executor' and correct template variables", async () => {
    mockBuildPrompt.mockClear();
    const issue = makeIssue();
    const config = makeConfig();

    await executeIssue({
      issue,
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(mockBuildPrompt).toHaveBeenCalledWith("executor", {
      ISSUE_ID: issue.identifier,
      IN_REVIEW_STATE: config.linear.states.in_review,
      BLOCKED_STATE: config.linear.states.blocked,
      PROJECT_NAME: config.project.name,
    });
  });
});

describe("executeIssue — timeout path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: true,
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
      error: undefined,
      costUsd: 0.1,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });
  });

  test("returns empty array when all slots are full", async () => {
    // Fill all 3 slots
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
    // 3 slots, 0 running → available=3, activeIssueIds.size=0 → fetch 3
    await fillSlots({
      config: makeConfig(3),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const calledWith = mockGetReadyIssues.mock.calls[0];
    // Second arg is the limit: available + activeIssueIds.size
    expect(calledWith[1]).toBeGreaterThanOrEqual(3);
  });

  test("filters out issues already being executed", async () => {
    const activeIssue = makeIssue();
    const freshIssue = makeIssue();

    // Start executing activeIssue without awaiting — this synchronously adds
    // activeIssue.id to activeIssueIds before the first await
    const hangingRunClaude = new Promise<
      typeof mockRunClaude extends (...args: any[]) => Promise<infer R>
        ? R
        : never
    >((resolve) => {
      setTimeout(
        () =>
          resolve({
            timedOut: false,
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

    // Restore normal behavior for fillSlots → executeIssue calls
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 100,
      numTurns: 1,
      result: "",
    });

    // getReadyIssues returns both issues but only freshIssue should start
    mockGetReadyIssues.mockResolvedValue([activeIssue, freshIssue]);

    const promises = await fillSlots({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // activeIssue is filtered out; only freshIssue gets a promise
    expect(promises).toHaveLength(1);

    // Cleanup: resolve all hanging promises
    await Promise.allSettled([...promises.map((p) => p), execPromise]);
  });
});
