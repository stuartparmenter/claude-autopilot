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
import type { AutopilotConfig, LinearIds } from "./lib/config";
import * as _realLinear from "./lib/linear";
import { AppState } from "./state";

// Snapshot of real linear module exports, captured before any mock.module()
// calls. Used in afterAll to restore the module for subsequent test files,
// because mock.restore() does not undo mock.module() in Bun 1.3.9.
const _realLinearSnapshot = { ..._realLinear };

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
const mockGetInProgressIssues = mock(
  (
    _linearIds: LinearIds,
  ): Promise<Array<{ id: string; identifier: string; updatedAt: Date }>> =>
    Promise.resolve([]),
);

import {
  executeIssue,
  fillSlots,
  recoverAgentsOnShutdown,
  recoverStaleIssues,
} from "./executor";

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
    getInProgressIssues: mockGetInProgressIssues,
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
      parallel: parallelSlots,
      timeout_minutes: 30,
      fixer_timeout_minutes: 20,
      max_fixer_attempts: 3,
      max_retries: 3,
      inactivity_timeout_minutes: 10,
      poll_interval_minutes: 5,
      stale_timeout_minutes: 15,
      auto_approve_labels: [],
      branch_pattern: "autopilot/{{id}}",
      commit_pattern: "{{id}}: {{title}}",
      model: "sonnet",
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
      backlog_review_interval_minutes: 240,
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
      enabled: false,
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

describe("executeIssue — inactivity timeout path", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: true,
      inactivityTimedOut: true,
      error: "Inactivity timeout",
      costUsd: undefined,
      durationMs: 1800000,
      numTurns: 10,
      result: "",
    });
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("moves issue to ready state on inactivity timeout (not blocked)", async () => {
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
    const blockedCall = mockUpdateIssue.mock.calls.find(
      (call) => call[1]?.stateId === "blocked-id",
    );
    expect(blockedCall).toBeUndefined();
  });
});

describe("executeIssue — token sanitization in Linear comment", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("redacts tokens in error before posting to Linear", async () => {
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: "Failed: Bearer sk-ant-secret123 and ghp_mygithubtoken",
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
      result: "",
    });

    const issue = makeIssue();
    const config = makeConfig();
    // Force max_retries = 1 so the blocked comment is posted on first failure
    config.executor.max_retries = 1;

    mockUpdateIssue.mockClear();
    await executeIssue({
      issue,
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const blockedCall = mockUpdateIssue.mock.calls.find(
      (call) => call[1]?.stateId === "blocked-id",
    );
    const comment: string = blockedCall?.[1]?.comment ?? "";
    expect(comment).not.toContain("sk-ant-secret123");
    expect(comment).not.toContain("mygithubtoken");
    expect(comment).toContain("[REDACTED]");
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

describe("executeIssue — runClaude throws", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("no ghost agent when runClaude rejects", async () => {
    mockRunClaude.mockRejectedValue(new Error("Worktree creation failed"));

    await executeIssue({
      issue: makeIssue(),
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getRunningCount()).toBe(0);
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

  test("returns empty array when budget is exhausted", async () => {
    state.addSpend(10); // $10 spent
    const config = makeConfig();
    config.budget.daily_limit_usd = 5; // $5 limit — exhausted

    const promises = await fillSlots({
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(promises).toHaveLength(0);
  });

  test("auto-pauses when budget is exhausted", async () => {
    state.addSpend(10);
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    expect(state.isPaused()).toBe(false);

    await fillSlots({
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.isPaused()).toBe(true);
  });

  test("does not double-pause when already paused and budget is exhausted", async () => {
    state.addSpend(10);
    state.togglePause(); // already paused
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    await fillSlots({
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // togglePause flips the flag — calling it again would un-pause. It should NOT be called.
    expect(state.isPaused()).toBe(true);
  });

  test("does not query Linear when budget is exhausted", async () => {
    state.addSpend(10);
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    mockGetReadyIssues.mockClear();

    await fillSlots({
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(mockGetReadyIssues).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// recoverStaleIssues
// ---------------------------------------------------------------------------

describe("recoverStaleIssues", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockUpdateIssue.mockClear();
    mockUpdateIssue.mockResolvedValue(undefined);
    mockGetInProgressIssues.mockClear();
    mockGetInProgressIssues.mockResolvedValue([]);
  });

  function staleIssue(id: string, identifier: string, ageMs = 20 * 60 * 1000) {
    return {
      id,
      identifier,
      updatedAt: new Date(Date.now() - ageMs),
    };
  }

  test("returns 0 when there are no In Progress issues", async () => {
    mockGetInProgressIssues.mockResolvedValue([]);
    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });
    expect(count).toBe(0);
  });

  test("recovers a stale issue with no running agent", async () => {
    mockGetInProgressIssues.mockResolvedValue([
      staleIssue("issue-stale-1", "ENG-stale-1"),
    ]);

    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(count).toBe(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-stale-1", {
      stateId: "ready-id",
      comment: expect.stringContaining("stale"),
    });
  });

  test("does NOT recover an issue that has a matching running agent", async () => {
    const activeIssue = staleIssue("issue-active-1", "ENG-active-1");
    state.addAgent("agent-1", "ENG-active-1", "Active Issue", "issue-active-1");
    mockGetInProgressIssues.mockResolvedValue([activeIssue]);

    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(count).toBe(0);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  test("does NOT recover an issue recently updated (within timeout)", async () => {
    // updatedAt is only 5 minutes ago, timeout is 15 minutes
    const recentIssue = staleIssue(
      "issue-recent-1",
      "ENG-recent-1",
      5 * 60 * 1000,
    );
    mockGetInProgressIssues.mockResolvedValue([recentIssue]);

    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(count).toBe(0);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  test("calls updateIssue with ready stateId and a comment", async () => {
    mockGetInProgressIssues.mockResolvedValue([staleIssue("issue-x", "ENG-x")]);
    mockUpdateIssue.mockClear();

    await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const call = mockUpdateIssue.mock.calls[0];
    expect(call[0]).toBe("issue-x");
    expect(call[1].stateId).toBe("ready-id");
    expect(call[1].comment).toBeTruthy();
  });

  test("recovers multiple stale issues and returns correct count", async () => {
    mockGetInProgressIssues.mockResolvedValue([
      staleIssue("issue-a", "ENG-a"),
      staleIssue("issue-b", "ENG-b"),
    ]);

    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(count).toBe(2);
  });

  test("skips active issues and recovers only stale orphans", async () => {
    state.addAgent("agent-y", "ENG-y", "Active Y", "issue-y");
    mockGetInProgressIssues.mockResolvedValue([
      staleIssue("issue-y", "ENG-y"), // active — should be skipped
      staleIssue("issue-z", "ENG-z"), // orphaned — should be recovered
    ]);

    const count = await recoverStaleIssues({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(count).toBe(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "issue-z",
      expect.objectContaining({ stateId: "ready-id" }),
    );
  });
});

// ---------------------------------------------------------------------------
// recoverAgentsOnShutdown
// ---------------------------------------------------------------------------

describe("recoverAgentsOnShutdown", () => {
  beforeEach(() => {
    mockUpdateIssue.mockClear();
    mockUpdateIssue.mockResolvedValue(undefined);
  });

  test("returns 0 and makes no API calls when agents list is empty", async () => {
    const count = await recoverAgentsOnShutdown([], "ready-id");
    expect(count).toBe(0);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  test("returns 0 and makes no API calls when no agents have linearIssueId", async () => {
    const agents = [{ linearIssueId: undefined }, { linearIssueId: undefined }];
    const count = await recoverAgentsOnShutdown(agents, "ready-id");
    expect(count).toBe(0);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  test("calls updateIssue for each agent with a linearIssueId", async () => {
    const agents = [{ linearIssueId: "issue-1" }, { linearIssueId: "issue-2" }];
    const count = await recoverAgentsOnShutdown(agents, "ready-id");
    expect(count).toBe(2);
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "ready-id",
      comment: expect.stringContaining("SIGINT/SIGTERM"),
    });
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-2", {
      stateId: "ready-id",
      comment: expect.stringContaining("SIGINT/SIGTERM"),
    });
  });

  test("skips agents without linearIssueId and recovers those with one", async () => {
    const agents = [
      { linearIssueId: "issue-a" },
      { linearIssueId: undefined },
      { linearIssueId: "issue-b" },
    ];
    const count = await recoverAgentsOnShutdown(agents, "ready-id");
    expect(count).toBe(2);
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-a", expect.anything());
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-b", expect.anything());
  });

  test("uses the provided readyStateId", async () => {
    const agents = [{ linearIssueId: "issue-x" }];
    await recoverAgentsOnShutdown(agents, "custom-ready-state");
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "issue-x",
      expect.objectContaining({ stateId: "custom-ready-state" }),
    );
  });

  test("posts a comment explaining the recovery", async () => {
    const agents = [{ linearIssueId: "issue-y" }];
    await recoverAgentsOnShutdown(agents, "ready-id");
    const call = mockUpdateIssue.mock.calls[0];
    expect(call[1].comment).toContain("Ready for re-execution");
  });
});

// Restore the real linear module after all executor tests complete.
// mock.restore() in afterEach does not undo mock.module() in Bun 1.3.9,
// which causes cross-file interference with subsequent test files (e.g.
// src/lib/linear.test.ts). Calling mock.module() here with the real
// implementations (captured before any mocking) fixes the leakage.
afterAll(() => {
  mock.module("./lib/linear", () => ({
    ..._realLinearSnapshot,
  }));
});
