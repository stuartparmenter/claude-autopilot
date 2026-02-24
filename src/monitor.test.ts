import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeResult } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { AppState } from "./state";

// Mock modules BEFORE importing the module under test
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
const mockGetPRStatus = mock(() =>
  Promise.resolve({
    merged: false,
    mergeable: null as boolean | null,
    ciStatus: "success" as "success" | "failure" | "pending",
    ciDetails: "",
    branch: "feature/test",
  }),
);
const mockIssuesQuery = mock(() =>
  Promise.resolve({ nodes: [] as ReturnType<typeof makeIssue>[] }),
);
const mockBuildPrompt = mock(() => "mock-fixer-prompt");

mock.module("./lib/claude", () => ({ runClaude: mockRunClaude }));
mock.module("./lib/github", () => ({ getPRStatus: mockGetPRStatus }));
mock.module("./lib/linear", () => ({
  getLinearClient: () => ({ issues: mockIssuesQuery }),
}));
mock.module("./lib/prompt", () => ({ buildPrompt: mockBuildPrompt }));

import { checkOpenPRs } from "./monitor";

// Restore all module mocks after this file so other test files are not affected
afterAll(() => mock.restore());

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
      inactivity_timeout_minutes: 10,
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
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "success",
      ciDetails: "",
      branch: "feature/test",
    });
    mockIssuesQuery.mockResolvedValue({ nodes: [] });
  });

  test("returns empty array when no In Review issues", async () => {
    mockIssuesQuery.mockResolvedValue({ nodes: [] });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("skips issues with no GitHub attachment", async () => {
    const issue = makeIssue("no-attach"); // no prUrl → empty attachments
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

    // Should not throw — just skips the issue
    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("parses PR number from URL and spawns fixer for ciStatus:failure", async () => {
    const issue = makeIssue("ci-fail", "https://github.com/o/r/pull/42");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "failure",
      ciDetails: "test: failure",
      branch: "feature/ci-fail",
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    // Await to let fixer complete and clean up activeFixerIssues
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
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: false,
      ciStatus: "success",
      ciDetails: "",
      branch: "feature/conflict",
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("does NOT spawn fixer when ciStatus:success and mergeable:null", async () => {
    const issue = makeIssue("ok-pr", "https://github.com/o/r/pull/20");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "success",
      ciDetails: "",
      branch: "feature/ok",
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("does NOT spawn fixer when ciStatus:pending", async () => {
    const issue = makeIssue("pending-pr", "https://github.com/o/r/pull/30");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "pending",
      ciDetails: "",
      branch: "feature/pending",
    });

    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(0);
  });

  test("does NOT spawn fixer when ciStatus:success and mergeable:true", async () => {
    const issue = makeIssue("clean-pr", "https://github.com/o/r/pull/50");
    mockIssuesQuery.mockResolvedValue({ nodes: [issue] });
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: true,
      ciStatus: "success",
      ciDetails: "",
      branch: "feature/clean",
    });

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
  });

  test("stops spawning fixers when slot limit reached", async () => {
    // 3 parallel slots, 2 running → 1 slot left
    state.addAgent("running-1", "ENG-a", "A");
    state.addAgent("running-2", "ENG-b", "B");

    // 3 issues all need fixing
    const issues = [
      makeIssue("slot-1", "https://github.com/o/r/pull/61"),
      makeIssue("slot-2", "https://github.com/o/r/pull/62"),
      makeIssue("slot-3", "https://github.com/o/r/pull/63"),
    ];
    mockIssuesQuery.mockResolvedValue({ nodes: issues });
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "failure",
      ciDetails: "fail",
      branch: "feature/slot",
    });

    const result = await checkOpenPRs(makeOpts(state, makeConfig(3)));

    // Only 1 slot was available
    expect(result).toHaveLength(1);
    await Promise.all(result);
  });

  test("skips issues that already have an active fixer", async () => {
    // Make runClaude hang so activeFixerIssues isn't cleaned up between calls
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
    mockGetPRStatus.mockResolvedValue({
      merged: false,
      mergeable: null,
      ciStatus: "failure",
      ciDetails: "fail",
      branch: "feature/dedup",
    });

    // First call: starts a fixer, adds issue.id to activeFixerIssues
    const firstResult = await checkOpenPRs(makeOpts(state));
    expect(firstResult).toHaveLength(1);

    // Second call with same issue: should be skipped (already in activeFixerIssues)
    const secondResult = await checkOpenPRs(makeOpts(state));
    expect(secondResult).toHaveLength(0);

    // Cleanup
    resolveFirst!();
    await Promise.all(firstResult);
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

    let callCount = 0;
    mockGetPRStatus.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("GitHub API error"));
      }
      return Promise.resolve({
        merged: false,
        mergeable: null,
        ciStatus: "failure",
        ciDetails: "fail",
        branch: "feature/good",
      });
    });

    // Should not throw, should process the second issue despite first throwing
    const result = await checkOpenPRs(makeOpts(state));

    expect(result).toHaveLength(1);
    await Promise.all(result);
  });
});
