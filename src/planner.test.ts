import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { ClaudeResult } from "./lib/claude";
import * as _realClaude from "./lib/claude";

// Snapshot of real claude module exports, captured before any mock.module()
// calls. Used in afterAll to restore the module for subsequent test files,
// because mock.restore() does not undo mock.module() in Bun 1.3.9.
const _realClaudeSnapshot = { ..._realClaude };

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

// Mock state for sequential rawRequest calls.
// First call: getReadyIssues (returns full issue nodes with inverseRelations/children)
// Second call: countIssuesInState for triage (returns minimal {id} nodes + pageInfo)
let readyIssueNodes: Array<{
  id: string;
  identifier: string;
  title: string;
  priority: number | null;
  inverseRelations: { nodes: never[] };
  children: { nodes: never[] };
}> = [];
let triageNodeCount = 0;
let rawCallIndex = 0;
const mockRawRequest = mock(async () => {
  const callIndex = rawCallIndex++;
  // First call is getReadyIssues (returns full issue nodes)
  if (callIndex === 0) {
    return {
      data: {
        issues: {
          nodes: readyIssueNodes,
        },
      },
    };
  }
  // Second call is countIssuesInState for triage (returns minimal nodes + pageInfo)
  return {
    data: {
      issues: {
        nodes: Array.from({ length: triageNodeCount }, (_, i) => ({
          id: `triage-${i}`,
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
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
  readyIssueNodes = [];
  triageNodeCount = 0;
  rawCallIndex = 0;
  mockRawRequest.mockClear();
  setClientForTesting({
    client: { rawRequest: mockRawRequest },
  } as unknown as LinearClient);
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
    monitor: {
      respond_to_reviews: false,
      review_responder_timeout_minutes: 20,
    },
    github: { repo: "", automerge: false },
    project: { name: "" },
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
      enabled: true,
      auto_allow_bash: true,
      network_restricted: false,
      extra_allowed_domains: [],
    },
    reviewer: {
      enabled: false,
      min_interval_minutes: 120,
      min_runs_before_review: 10,
      timeout_minutes: 60,
      model: "opus",
      max_issues_per_review: 5,
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
    managedLabelId: "managed-label-id",
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

function makeReadyIssueNode(id: string) {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Test ${id}`,
    priority: 3 as number | null,
    inverseRelations: { nodes: [] as never[] },
    children: { nodes: [] as never[] },
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
    mockRawRequest.mockClear();

    const result = await shouldRunPlanning({
      config,
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
    // Short-circuits before any API call
    expect(mockRawRequest.mock.calls).toHaveLength(0);
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
    readyIssueNodes = [
      makeReadyIssueNode("1"),
      makeReadyIssueNode("2"),
      makeReadyIssueNode("3"),
    ];
    triageNodeCount = 2;

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
  });

  test("returns true when backlog < threshold", async () => {
    // readyCount=2, triageCount=1 → backlog=3, threshold=5 → true
    readyIssueNodes = [makeReadyIssueNode("1"), makeReadyIssueNode("2")];
    triageNodeCount = 1;

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("queries ready state via getReadyIssues and triage via countIssuesInState", async () => {
    mockRawRequest.mockClear();
    rawCallIndex = 0;

    const linearIds = makeLinearIds();
    await shouldRunPlanning({
      config: makeConfig(),
      linearIds,
      state,
    });

    // First call: getReadyIssues filters by ready state
    const firstCallFilter = (mockRawRequest.mock.calls[0] as unknown[])[1] as {
      filter: { state: { id: { eq: string } } };
    };
    expect(firstCallFilter.filter.state.id.eq).toBe("ready-id");

    // Second call: countIssuesInState for triage
    const secondCallFilter = (mockRawRequest.mock.calls[1] as unknown[])[1] as {
      filter: { state: { id: { eq: string } } };
    };
    expect(secondCallFilter.filter.state.id.eq).toBe("triage-id");
  });

  test("forwards config labels filter to both queries", async () => {
    mockRawRequest.mockClear();
    rawCallIndex = 0;
    const config = makeConfig();
    config.linear.labels = ["autopilot", "backend"];

    await shouldRunPlanning({ config, linearIds: makeLinearIds(), state });

    const calledFilters = mockRawRequest.mock.calls.map(
      (call: unknown[]) =>
        (
          call[1] as {
            filter: { labels?: { some: { name: { in: string[] } } } };
          }
        )?.filter?.labels,
    );
    // Both getReadyIssues and countIssuesInState should have labels filter
    expect(calledFilters[0]).toEqual({
      some: { name: { in: ["autopilot", "backend"] } },
    });
    expect(calledFilters[1]).toEqual({
      some: { name: { in: ["autopilot", "backend"] } },
    });
  });

  test("forwards config projects filter to both queries", async () => {
    mockRawRequest.mockClear();
    rawCallIndex = 0;
    const config = makeConfig();
    config.linear.projects = ["Alpha"];

    await shouldRunPlanning({ config, linearIds: makeLinearIds(), state });

    const calledProjects = mockRawRequest.mock.calls.map(
      (call: unknown[]) =>
        (
          call[1] as {
            filter: { project?: { name: { in: string[] } } };
          }
        )?.filter?.project,
    );
    expect(calledProjects[0]).toEqual({ name: { in: ["Alpha"] } });
    expect(calledProjects[1]).toEqual({ name: { in: ["Alpha"] } });
  });

  test("omits label/project filters when config has empty arrays", async () => {
    mockRawRequest.mockClear();
    rawCallIndex = 0;
    const config = makeConfig();
    // labels and projects default to [] in makeConfig()

    await shouldRunPlanning({ config, linearIds: makeLinearIds(), state });

    const calledFilters = mockRawRequest.mock.calls.map(
      (call: unknown[]) =>
        (call[1] as { filter: Record<string, unknown> })?.filter,
    );
    for (const f of calledFilters) {
      expect(f).not.toHaveProperty("labels");
      expect(f).not.toHaveProperty("project");
    }
  });
});

// ---------------------------------------------------------------------------
// runPlanning — success path
// ---------------------------------------------------------------------------

describe("shouldRunPlanning — min interval check", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns false when lastRunAt is within the interval", async () => {
    // Set lastRunAt to 30 minutes ago, interval is 60 minutes
    state.updatePlanning({ lastRunAt: Date.now() - 30 * 60 * 1000 });
    // Backlog is low so threshold check would pass
    readyIssueNodes = [];
    triageNodeCount = 0;

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
    // Should short-circuit before making any API calls
    expect(mockRawRequest.mock.calls).toHaveLength(0);
  });

  test("returns true when lastRunAt is older than the interval and backlog is low", async () => {
    // Set lastRunAt to 90 minutes ago, interval is 60 minutes
    state.updatePlanning({ lastRunAt: Date.now() - 90 * 60 * 1000 });
    // Backlog is low so threshold check passes
    readyIssueNodes = [];
    triageNodeCount = 0;

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("returns true when lastRunAt is undefined (first run) and backlog is low", async () => {
    // No lastRunAt set — first run
    readyIssueNodes = [];
    triageNodeCount = 0;

    const result = await shouldRunPlanning({
      config: makeConfig(),
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(true);
  });

  test("returns false when lastRunAt is within interval even if backlog is below threshold", async () => {
    const config = makeConfig();
    config.planning.min_interval_minutes = 120;
    // Set lastRunAt to 60 minutes ago — within 120 minute interval
    state.updatePlanning({ lastRunAt: Date.now() - 60 * 60 * 1000 });
    readyIssueNodes = [];
    triageNodeCount = 0;

    const result = await shouldRunPlanning({
      config,
      linearIds: makeLinearIds(),
      state,
    });

    expect(result).toBe(false);
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

  test("records planning session in history on success", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const sessions = state.getPlanningHistory();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("completed");
    expect(sessions[0].costUsd).toBe(0.5);
    expect(sessions[0].issuesFiledCount).toBe(0);
    expect(sessions[0].startedAt).toBeDefined();
    expect(sessions[0].finishedAt).toBeDefined();
    expect(sessions[0].agentRunId).toMatch(/^planning-/);
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

  test("records planning session with timed_out status", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const sessions = state.getPlanningHistory();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("timed_out");
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

  test("records planning session with failed status on error result", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const sessions = state.getPlanningHistory();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// runPlanning — crash path (runClaude rejects)
// ---------------------------------------------------------------------------

describe("runPlanning — crash path (runClaude rejects)", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockRejectedValue(new Error("boom"));
  });

  test("sets running=false, lastResult='failed', and records failed history when runClaude rejects", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    expect(state.getPlanningStatus().running).toBe(false);
    expect(state.getPlanningStatus().lastResult).toBe("failed");
    expect(state.getHistory()[0].status).toBe("failed");
  });

  test("records planning session with failed status when runClaude rejects", async () => {
    await runPlanning({
      config: makeConfig(),
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    const sessions = state.getPlanningHistory();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("failed");
    expect(sessions[0].issuesFiledCount).toBe(0);
    expect(sessions[0].agentRunId).toMatch(/^planning-/);
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
