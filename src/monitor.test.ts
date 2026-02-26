import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeResult } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { AppState } from "./state";

// Set fake tokens so clients don't throw during tests
process.env.GITHUB_TOKEN = "test-token-monitor";
process.env.LINEAR_API_KEY = "test-key-monitor-linear";

// ---------------------------------------------------------------------------
// Mock functions — created once, re-wired per test via beforeEach
// ---------------------------------------------------------------------------

const mockRunClaude = mock(
  (): Promise<ClaudeResult> =>
    Promise.resolve({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
      sessionId: undefined,
    }),
);
const mockIssuesQuery = mock(() =>
  Promise.resolve({ nodes: [] as ReturnType<typeof makeIssue>[] }),
);

// Mutable state that controls what the mock Octokit returns.
// By mutating these objects before each test we avoid mock.module leakage
// across test files — we mock the npm "octokit" package (not ./lib/github)
// so github.test.ts is unaffected.
let prData: Record<string, unknown> = {
  merged: false,
  mergeable: null,
  head: { ref: "feature/test", sha: "abc123" },
};
let checkRunsData: Record<string, unknown> = { check_runs: [] };
let reviewsData: Record<string, unknown>[] = [];
let reviewCommentsData: Record<string, unknown>[] = [];

const mockPullsGet = mock(() => Promise.resolve({ data: prData }));
const mockChecksListForRef = mock(() =>
  Promise.resolve({ data: checkRunsData }),
);
const mockListReviews = mock(() => Promise.resolve({ data: reviewsData }));
const mockListReviewComments = mock(() =>
  Promise.resolve({ data: reviewCommentsData }),
);

import { resetClient } from "./lib/github";
import { resetClient as resetLinearClient } from "./lib/linear";
import { checkOpenPRs, resetHandledReviewIds } from "./monitor";

// Wire module mocks before each test and restore afterwards to prevent
// leaking into other test files in Bun's single-process test runner.
// NOTE: We mock npm packages ("octokit", "@linear/sdk") instead of local
// modules ("./lib/github", "./lib/linear") so that github.test.ts and
// linear.test.ts can test the real implementations without interference.
// We intentionally do NOT mock ./lib/prompt — the real buildPrompt reads
// from prompts/ on disk and doesn't leak across test files.
beforeEach(() => {
  resetClient();
  resetLinearClient();
  resetHandledReviewIds();
  mock.module("./lib/claude", () => ({
    runClaude: mockRunClaude,
    buildMcpServers: () => ({}),
  }));
  mock.module("@linear/sdk", () => ({
    LinearClient: class MockLinearClient {
      issues = mockIssuesQuery;
    },
  }));
  mock.module("octokit", () => ({
    Octokit: class MockOctokit {
      rest = {
        pulls: {
          get: mockPullsGet,
          listReviews: mockListReviews,
          listReviewComments: mockListReviewComments,
        },
        checks: { listForRef: mockChecksListForRef },
      };
    },
  }));

  // Reset mutable mock state to a safe baseline
  prData = {
    merged: false,
    mergeable: null,
    head: { ref: "feature/test", sha: "abc123" },
  };
  checkRunsData = { check_runs: [] };
  reviewsData = [];
  reviewCommentsData = [];
  mockPullsGet.mockImplementation(() => Promise.resolve({ data: prData }));
  mockListReviews.mockImplementation(() =>
    Promise.resolve({ data: reviewsData }),
  );
  mockListReviewComments.mockImplementation(() =>
    Promise.resolve({ data: reviewCommentsData }),
  );
});

afterEach(() => {
  mock.restore();
  resetLinearClient();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  id: string,
  prUrl?: string,
): {
  id: string;
  identifier: string;
  title: string;
  attachments: () => Promise<{
    nodes: Array<{ sourceType: string; url: string }>;
  }>;
} {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    attachments: mock(() =>
      Promise.resolve({
        nodes: prUrl ? [{ sourceType: "github", url: prUrl }] : [],
      }),
    ),
  };
}

function makeConfig(
  parallelSlots = 3,
  respondToReviews = false,
  executorOverrides: Partial<AutopilotConfig["executor"]> = {},
): AutopilotConfig {
  return {
    linear: {
      team: "ENG",
      initiative: "test-initiative",
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
      auto_approve_labels: [],
      branch_pattern: "autopilot/{{id}}",
      commit_pattern: "{{id}}: {{title}}",
      model: "sonnet",
      ...executorOverrides,
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
      respond_to_reviews: respondToReviews,
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
    initiativeId: "init-id",
    initiativeName: "test-initiative",
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

function makeOpts(state: AppState, config = makeConfig()) {
  return {
    owner: "testowner",
    repo: "testrepo",
    config,
    projectPath: "/project",
    linearIds: makeLinearIds(),
    state,
  };
}

// ---------------------------------------------------------------------------
// checkOpenPRs tests
// ---------------------------------------------------------------------------

describe("checkOpenPRs — basic cases", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });
    mockIssuesQuery.mockResolvedValue({ nodes: [] });
  });

  test("returns empty array when no In Review issues", async () => {
    mockIssuesQuery.mockResolvedValue({ nodes: [] });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("skips issues with no GitHub attachment", async () => {
    const issue = makeIssue("no-attach");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("warns and skips issues with unparseable PR URL", async () => {
    const issue = makeIssue(
      "bad-url",
      "https://github.com/owner/repo/compare/branch",
    );
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("parses PR number from URL and spawns fixer for ciStatus:failure", async () => {
    const issue = makeIssue("ci-fail", "https://github.com/o/r/pull/42");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // Configure octokit mock: all checks completed with failure
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/ci-fail", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "tests" },
      ],
    };

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });
});

describe("checkOpenPRs — fixer spawn conditions", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });
    mockIssuesQuery.mockResolvedValue({ nodes: [] });
  });

  test("spawns fixer when mergeable:false (merge conflict)", async () => {
    const issue = makeIssue("conflict", "https://github.com/o/r/pull/10");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // CI passes but PR has merge conflicts
    prData = {
      merged: false,
      mergeable: false,
      head: { ref: "feature/conflict", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "checks" },
      ],
    };

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("does NOT spawn fixer when ciStatus:success and mergeable:null", async () => {
    const issue = makeIssue("ok-pr", "https://github.com/o/r/pull/20");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // CI passes, mergeable not yet computed
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/ok", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "checks" },
      ],
    };

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("does NOT spawn fixer when ciStatus:pending", async () => {
    const issue = makeIssue("pending-pr", "https://github.com/o/r/pull/30");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // No checks yet → pending
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/pending", sha: "abc123" },
    };
    checkRunsData = { check_runs: [] };

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("does NOT spawn fixer when ciStatus:success and mergeable:true", async () => {
    const issue = makeIssue("clean-pr", "https://github.com/o/r/pull/50");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // Everything green
    prData = {
      merged: false,
      mergeable: true,
      head: { ref: "feature/clean", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "checks" },
      ],
    };

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });
});

describe("checkOpenPRs — slot limiting and dedup", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });
    // Default: CI failure so fixers get spawned
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/slot", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "tests" },
      ],
    };
  });

  test("stops spawning fixers when slot limit reached", async () => {
    state.addAgent("running-1", "ENG-a", "A");
    state.addAgent("running-2", "ENG-b", "B");

    const issues = [
      makeIssue("slot-1", "https://github.com/o/r/pull/61"),
      makeIssue("slot-2", "https://github.com/o/r/pull/62"),
      makeIssue("slot-3", "https://github.com/o/r/pull/63"),
    ];
    mockIssuesQuery.mockResolvedValue({ nodes: issues });

    const result = await checkOpenPRs(makeOpts(state, makeConfig(3)));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("skips issues that already have an active fixer", async () => {
    let resolveFirst: () => void;
    const hanging = new Promise<
      ReturnType<
        typeof mockRunClaude extends (...a: any[]) => Promise<infer R>
          ? (...a: any[]) => Promise<R>
          : never
      >
    >((resolve) => {
      resolveFirst = () =>
        resolve({
          timedOut: false,
          inactivityTimedOut: false,
          error: undefined,
          costUsd: 0,
          durationMs: 0,
          numTurns: 0,
          result: "",
        } as any);
    });
    mockRunClaude.mockReturnValue(hanging as any);

    const issue = makeIssue("dedup-issue", "https://github.com/o/r/pull/71");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    const firstResult = await checkOpenPRs(makeOpts(state));
    expect(firstResult).toHaveLength(1);

    const secondResult = await checkOpenPRs(makeOpts(state));
    expect(secondResult).toHaveLength(0);

    resolveFirst!();
    await Promise.all(firstResult);
  });

  test("retries client.issues() on transient 503 error", async () => {
    let callCount = 0;
    mockIssuesQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(
          Object.assign(new Error("Service Unavailable"), { status: 503 }),
        );
      }
      return Promise.resolve({ nodes: [] });
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
    expect(callCount).toBe(2);
  });

  test("retries issue.attachments() on transient 503 error", async () => {
    const issue = makeIssue("retry-attach", "https://github.com/o/r/pull/92");
    let callCount = 0;
    issue.attachments = () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(
          Object.assign(new Error("Service Unavailable"), { status: 503 }),
        ) as ReturnType<(typeof issue)["attachments"]>;
      }
      return Promise.resolve({
        nodes: [
          { sourceType: "github", url: "https://github.com/o/r/pull/92" },
        ],
      });
    };
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    const result = await checkOpenPRs(makeOpts(state));

    expect(callCount).toBe(2);
    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("continues processing subsequent issues when attachments() throws", async () => {
    const failingIssue = makeIssue(
      "fail-attach",
      "https://github.com/o/r/pull/90",
    );
    const goodIssue = makeIssue(
      "good-attach",
      "https://github.com/o/r/pull/91",
    );

    // Make the first issue's attachments throw
    failingIssue.attachments = () =>
      Promise.reject(new Error("Network error")) as ReturnType<
        (typeof failingIssue)["attachments"]
      >;

    mockIssuesQuery.mockResolvedValue({ nodes: [failingIssue, goodIssue] });

    const result = await checkOpenPRs(makeOpts(state));

    // goodIssue should be processed despite the first one's attachments failing
    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("continues processing subsequent issues when getPRStatus throws", async () => {
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });

    const failingIssue = makeIssue(
      "throw-pr",
      "https://github.com/o/r/pull/80",
    );
    const goodIssue = makeIssue("good-pr", "https://github.com/o/r/pull/81");
    mockIssuesQuery.mockResolvedValue({
      nodes: [failingIssue, goodIssue],
    });

    // First getPRStatus call throws (via pulls.get), second succeeds
    let pullsCallCount = 0;
    mockPullsGet.mockImplementation(() => {
      pullsCallCount++;
      if (pullsCallCount === 1) {
        return Promise.reject(new Error("GitHub API error"));
      }
      return Promise.resolve({ data: prData });
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });
});

// ---------------------------------------------------------------------------
// Review responder tests
// ---------------------------------------------------------------------------

describe("checkOpenPRs — review responder", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });
    // Default: CI passing, no merge conflict, no reviews
    prData = {
      merged: false,
      mergeable: true,
      head: { ref: "feature/review-test", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "tests" },
      ],
    };
    reviewsData = [];
    reviewCommentsData = [];
  });

  test("does NOT spawn review responder when respond_to_reviews is false", async () => {
    const issue = makeIssue("rr-disabled", "https://github.com/o/r/pull/200");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    reviewsData = [
      {
        id: 1001,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, false); // respond_to_reviews = false
    const result = await checkOpenPRs(makeOpts(state, config));

    expect(result).toHaveLength(0);
  });

  test("spawns review responder when CI passing and CHANGES_REQUESTED review exists", async () => {
    const issue = makeIssue("rr-spawn", "https://github.com/o/r/pull/201");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    reviewsData = [
      {
        id: 1002,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Please fix naming",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true); // respond_to_reviews = true
    const result = await checkOpenPRs(makeOpts(state, config));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("does NOT spawn review responder when CI is failing (fixer takes priority)", async () => {
    const issue = makeIssue("rr-ci-fail", "https://github.com/o/r/pull/202");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // CI is failing
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "tests" },
      ],
    };
    reviewsData = [
      {
        id: 1003,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true);
    const result = await checkOpenPRs(makeOpts(state, config));

    // Should spawn CI fixer, not review responder
    expect(result).toHaveLength(1);
    // Verify it's a fixer by checking that mockRunClaude was called with fixer prompt context
    await Promise.all(result);
  });

  test("does NOT spawn review responder when there is a merge conflict", async () => {
    const issue = makeIssue("rr-conflict", "https://github.com/o/r/pull/203");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // CI passing but merge conflict
    prData = {
      merged: false,
      mergeable: false,
      head: { ref: "feature/review-test", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "tests" },
      ],
    };
    reviewsData = [
      {
        id: 1004,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true);
    const result = await checkOpenPRs(makeOpts(state, config));

    // Should spawn merge conflict fixer, not review responder
    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("does NOT spawn review responder when CI is pending", async () => {
    const issue = makeIssue("rr-pending", "https://github.com/o/r/pull/204");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    // CI is still running
    checkRunsData = {
      check_runs: [{ status: "in_progress", conclusion: null, name: "tests" }],
    };
    reviewsData = [
      {
        id: 1005,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true);
    const result = await checkOpenPRs(makeOpts(state, config));

    expect(result).toHaveLength(0);
  });

  test("dedup: same review does not trigger multiple responders", async () => {
    const issue = makeIssue("rr-dedup", "https://github.com/o/r/pull/205");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    reviewsData = [
      {
        id: 1006,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true);

    // First call: should spawn one responder
    const firstResult = await checkOpenPRs(makeOpts(state, config));
    expect(firstResult).toHaveLength(1);
    await Promise.all(firstResult);

    // Second call: same review ID → dedup, no new responder
    const secondResult = await checkOpenPRs(makeOpts(state, config));
    expect(secondResult).toHaveLength(0);
  });

  test("new CHANGES_REQUESTED review after first is handled triggers new responder", async () => {
    const issue = makeIssue("rr-newreview", "https://github.com/o/r/pull/206");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    // First review
    reviewsData = [
      {
        id: 2001,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
    ];

    const config = makeConfig(3, true);

    // First call: spawns responder for review 2001
    const firstResult = await checkOpenPRs(makeOpts(state, config));
    expect(firstResult).toHaveLength(1);
    await Promise.all(firstResult);

    // Reviewer posts a new CHANGES_REQUESTED review (review 2002 is newer)
    reviewsData = [
      {
        id: 2001,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Fix this",
        submitted_at: "2026-01-01T10:00:00Z",
      },
      {
        id: 2002,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "Still needs work",
        submitted_at: "2026-01-01T12:00:00Z",
      },
    ];

    // Second call: new review ID 2002 → spawns new responder
    const secondResult = await checkOpenPRs(makeOpts(state, config));
    expect(secondResult).toHaveLength(1);
    await Promise.all(secondResult);
  });
});

describe("checkOpenPRs — budget enforcement", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockIssuesQuery.mockResolvedValue({ nodes: [] });
  });

  test("returns empty array when budget is exhausted", async () => {
    state.addSpend(10); // $10 spent
    const config = makeConfig();
    config.budget.daily_limit_usd = 5; // $5 limit — exhausted

    const result = await checkOpenPRs(makeOpts(state, config));

    expect(result).toHaveLength(0);
  });

  test("auto-pauses when budget is exhausted", async () => {
    state.addSpend(10);
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    expect(state.isPaused()).toBe(false);

    await checkOpenPRs(makeOpts(state, config));

    expect(state.isPaused()).toBe(true);
  });

  test("does not query Linear when budget is exhausted", async () => {
    state.addSpend(10);
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    mockIssuesQuery.mockClear();

    await checkOpenPRs(makeOpts(state, config));

    expect(mockIssuesQuery).not.toHaveBeenCalled();
  });

  test("does not double-pause when already paused and budget is exhausted", async () => {
    state.addSpend(10);
    state.togglePause(); // already paused
    const config = makeConfig();
    config.budget.daily_limit_usd = 5;

    await checkOpenPRs(makeOpts(state, config));

    expect(state.isPaused()).toBe(true);
  });
});

describe("checkOpenPRs — fixer timeout and attempt budget", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    mockRunClaude.mockResolvedValue({
      timedOut: false,
      inactivityTimedOut: false,
      error: undefined,
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
      result: "",
    });
    // Default: CI failure so fixers get spawned
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/budget", sha: "abc123" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "tests" },
      ],
    };
  });

  test("uses fixer_timeout_minutes from config", async () => {
    const config = makeConfig(3, false, { fixer_timeout_minutes: 45 });
    const issue = makeIssue("timeout-pr", "https://github.com/o/r/pull/400");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    mockRunClaude.mockClear();
    const result = await checkOpenPRs(makeOpts(state, config));
    expect(result).toHaveLength(1);
    await Promise.all(result);

    expect(mockRunClaude.mock.calls.length).toBeGreaterThan(0);
    const callArgs = (
      mockRunClaude.mock.calls as unknown as Array<[{ timeoutMs: number }]>
    )[0][0];
    expect(callArgs.timeoutMs).toBe(45 * 60 * 1000);
  });

  test("does not spawn fixer after max_fixer_attempts is reached", async () => {
    const config = makeConfig(3, false, { max_fixer_attempts: 2 });
    const issue = makeIssue("retry-pr", "https://github.com/o/r/pull/500");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    // First attempt
    const result1 = await checkOpenPRs(makeOpts(state, config));
    expect(result1).toHaveLength(1);
    await Promise.all(result1);

    // Second attempt
    const result2 = await checkOpenPRs(makeOpts(state, config));
    expect(result2).toHaveLength(1);
    await Promise.all(result2);

    // Third attempt: max reached, no fixer spawned
    const result3 = await checkOpenPRs(makeOpts(state, config));
    expect(result3).toHaveLength(0);
  });

  test("resets attempt counter when PR leaves In Review", async () => {
    const config = makeConfig(3, false, { max_fixer_attempts: 1 });
    const issue = makeIssue("reset-pr", "https://github.com/o/r/pull/600");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });

    // First attempt — fixer spawned, counter reaches max
    const result1 = await checkOpenPRs(makeOpts(state, config));
    expect(result1).toHaveLength(1);
    await Promise.all(result1);

    // Max reached — no fixer spawned
    const result2 = await checkOpenPRs(makeOpts(state, config));
    expect(result2).toHaveLength(0);

    // PR leaves "In Review" (no issues returned) — counter is pruned
    mockIssuesQuery.mockResolvedValue({ nodes: [] });
    await checkOpenPRs(makeOpts(state, config));

    // PR comes back to "In Review" — counter was reset, fixer spawned again
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    const result4 = await checkOpenPRs(makeOpts(state, config));
    expect(result4).toHaveLength(1);
    await Promise.all(result4);
  });
});
