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

const mockPullsGet = mock(() => Promise.resolve({ data: prData }));
const mockChecksListForRef = mock(() =>
  Promise.resolve({ data: checkRunsData }),
);

import { resetClient } from "./lib/github";
import { resetClient as resetLinearClient } from "./lib/linear";
import { checkOpenPRs } from "./monitor";

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
        pulls: { get: mockPullsGet },
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
  mockPullsGet.mockImplementation(() => Promise.resolve({ data: prData }));
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
