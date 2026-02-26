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
import * as _realClaude from "./lib/claude";
import type { ClaudeResult } from "./lib/claude";

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
// Mock functions
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

// Mock projects and issues data
let mockProjects: Array<{
  id: string;
  name: string;
  state: string;
  issues: (opts?: unknown) => Promise<{
    nodes: Array<{ id: string; identifier: string; title: string }>;
  }>;
}> = [];

const mockInitiative = mock(() =>
  Promise.resolve({
    id: "init-1",
    name: "Test Initiative",
    projects: mock(() => Promise.resolve({ nodes: mockProjects })),
  }),
);

import { checkProjects, resetActiveProjectIds } from "./projects";

beforeEach(() => {
  mockProjects = [];
  mockInitiative.mockClear();
  setClientForTesting({
    initiative: mockInitiative,
  } as unknown as LinearClient);
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
});

afterEach(() => {
  mock.restore();
  resetLinearClient();
  resetActiveProjectIds();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AutopilotConfig {
  return {
    linear: {
      team: "ENG",
      initiative: "Test Initiative",
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
      max_retries: 3,
      inactivity_timeout_minutes: 10,
      poll_interval_minutes: 5,
      auto_approve_labels: [],
      branch_pattern: "autopilot/{{id}}",
      commit_pattern: "{{id}}: {{title}}",
      model: "sonnet",
      stale_timeout_minutes: 15,
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

function makeLinearIds(withInitiative = true): LinearIds {
  return {
    teamId: "team-id",
    teamKey: "ENG",
    ...(withInitiative
      ? { initiativeId: "init-1", initiativeName: "Test Initiative" }
      : {}),
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

function makeProject(
  name: string,
  state: string,
  triageIssues: Array<{ id: string; identifier: string; title: string }> = [],
) {
  return {
    id: `project-${name}`,
    name,
    state,
    issues: mock(() => Promise.resolve({ nodes: triageIssues })),
  };
}

function makeOpts(
  state: AppState,
  config = makeConfig(),
  linearIds = makeLinearIds(),
) {
  return {
    config,
    projectPath: "/project",
    linearIds,
    state,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkProjects — early returns", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns empty when disabled", async () => {
    const config = makeConfig();
    config.projects.enabled = false;

    const result = await checkProjects(makeOpts(state, config));
    expect(result).toHaveLength(0);
  });

  test("returns empty when no initiative", async () => {
    const result = await checkProjects(
      makeOpts(state, makeConfig(), makeLinearIds(false)),
    );
    expect(result).toHaveLength(0);
  });
});

describe("checkProjects — project selection", () => {
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

  test("spawns owners for projects with triage issues", async () => {
    mockProjects = [
      makeProject("Auth Hardening", "started", [
        { id: "i1", identifier: "ENG-1", title: "Fix auth" },
      ]),
    ];

    const result = await checkProjects(makeOpts(state));
    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("skips projects with no triage issues", async () => {
    mockProjects = [makeProject("Empty Project", "started", [])];

    const result = await checkProjects(makeOpts(state));
    expect(result).toHaveLength(0);
  });

  test("skips completed projects", async () => {
    mockProjects = [
      makeProject("Done Project", "completed", [
        { id: "i1", identifier: "ENG-1", title: "Fix auth" },
      ]),
    ];

    const result = await checkProjects(makeOpts(state));
    expect(result).toHaveLength(0);
  });

  test("skips canceled projects", async () => {
    mockProjects = [
      makeProject("Canceled Project", "canceled", [
        { id: "i1", identifier: "ENG-1", title: "Fix auth" },
      ]),
    ];

    const result = await checkProjects(makeOpts(state));
    expect(result).toHaveLength(0);
  });

  test("respects max_active_projects cap", async () => {
    mockProjects = [
      makeProject("P1", "started", [
        { id: "i1", identifier: "ENG-1", title: "Issue 1" },
      ]),
      makeProject("P2", "started", [
        { id: "i2", identifier: "ENG-2", title: "Issue 2" },
      ]),
      makeProject("P3", "started", [
        { id: "i3", identifier: "ENG-3", title: "Issue 3" },
      ]),
    ];

    const config = makeConfig();
    config.projects.max_active_projects = 2;

    const result = await checkProjects(makeOpts(state, config));
    expect(result.length).toBeLessThanOrEqual(2);
    await Promise.all(result);
  });

  test("respects parallel agent limit", async () => {
    // Fill up 2 of 3 slots
    state.addAgent("a1", "ENG-100", "Test 1");
    state.addAgent("a2", "ENG-101", "Test 2");

    mockProjects = [
      makeProject("P1", "started", [
        { id: "i1", identifier: "ENG-1", title: "Issue 1" },
      ]),
      makeProject("P2", "started", [
        { id: "i2", identifier: "ENG-2", title: "Issue 2" },
      ]),
    ];

    const result = await checkProjects(makeOpts(state));
    // Only 1 slot available
    expect(result.length).toBeLessThanOrEqual(1);
    await Promise.all(result);
  });
});

describe("checkProjects — safety guards", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockClear();
  });

  test("does not spawn a second owner for an already-active project", async () => {
    mockProjects = [
      makeProject("Dedup-Test", "started", [
        { id: "i1", identifier: "ENG-1", title: "Issue 1" },
      ]),
    ];

    // Return a promise that stays pending so the first owner keeps running
    let resolveFirstRun!: (value: ClaudeResult) => void;
    const hangingPromise = new Promise<ClaudeResult>((resolve) => {
      resolveFirstRun = resolve;
    });
    mockRunClaude.mockImplementation(() => hangingPromise);

    // First call — spawns an owner; activeProjectIds now contains the project ID
    const firstResult = await checkProjects(makeOpts(state));
    expect(firstResult).toHaveLength(1);

    // Second call while the first owner is still running — must be skipped
    const secondResult = await checkProjects(makeOpts(state));
    expect(secondResult).toHaveLength(0);

    // runClaude was only invoked once across both checkProjects calls
    expect(mockRunClaude).toHaveBeenCalledTimes(1);

    // Resolve the hanging promise so the finally block cleans up
    resolveFirstRun({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.1,
      durationMs: 1000,
      numTurns: 1,
      result: "",
    });
    await Promise.all(firstResult);
  });

  test("returns empty and auto-pauses when budget is exhausted", async () => {
    mockProjects = [
      makeProject("Budget-Test", "started", [
        { id: "i1", identifier: "ENG-1", title: "Issue 1" },
      ]),
    ];

    // Exceed the daily budget limit
    state.addSpend(100);
    const config = makeConfig();
    config.budget.daily_limit_usd = 50;

    const result = await checkProjects(makeOpts(state, config));
    expect(result).toHaveLength(0);
    expect(state.isPaused()).toBe(true);
    expect(mockRunClaude).not.toHaveBeenCalled();
  });
});

describe("checkProjects — project owner crash recovery", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockRejectedValue(new Error("crash"));
  });

  test("records failed history entry when runClaude rejects", async () => {
    mockProjects = [
      makeProject("Auth Hardening", "started", [
        { id: "i1", identifier: "ENG-1", title: "Fix auth" },
      ]),
    ];

    const promises = await checkProjects(makeOpts(state));
    await Promise.all(promises);

    const history = state.getHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].status).toBe("failed");
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
