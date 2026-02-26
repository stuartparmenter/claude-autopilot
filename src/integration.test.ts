import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// Set env vars before any module code runs — consumed lazily at call time by
// linear-auth.ts (LINEAR_API_KEY) and agent-config.ts (both).
process.env.LINEAR_API_KEY = "test-key-integration";
process.env.GITHUB_TOKEN = "test-token-integration";

// Capture real module snapshots BEFORE any mock.module() calls so we can
// restore them in afterAll. Bun 1.3.9 mock.restore() does NOT undo mock.module().
import * as _realSdk from "@anthropic-ai/claude-agent-sdk";
import * as _realLinearSdk from "@linear/sdk";
import * as _realOctokit from "octokit";

const _realSdkSnapshot = { ..._realSdk };
const _realLinearSdkSnapshot = { ..._realLinearSdk };
const _realOctokitSnapshot = { ..._realOctokit };

import type { AutopilotConfig, LinearIds } from "./lib/config";
import { _worktree, resetSpawnGate } from "./lib/claude";
import { resetClient as resetGithubClient } from "./lib/github";
import { resetClient as resetLinearClient } from "./lib/linear";
import { checkOpenPRs, resetHandledReviewIds } from "./monitor";
import { executeIssue, fillSlots } from "./executor";
import { AppState } from "./state";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Async iterable that completes immediately with no messages.
 * Simulates a successful agent run: loopCompleted=true, no error set.
 */
function makeSuccessIterable(): AsyncIterable<unknown> & { close(): void } {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          return { done: true, value: undefined };
        },
      };
    },
    close() {},
  };
}

/**
 * Async iterable that throws on first iteration.
 * Simulates an agent SDK error: triggers the catch block in runClaude(),
 * which sets result.error = message and causes handleAgentResult() to
 * return { status: "failed" }.
 */
function makeErrorIterable(message: string): AsyncIterable<unknown> & {
  close(): void;
} {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw new Error(message);
        },
      };
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// Shared mock functions — reset in beforeEach
// ---------------------------------------------------------------------------

// Linear SDK: used by getReadyIssues() via client.client.rawRequest()
const mockRawRequest = mock(() =>
  Promise.resolve({ data: { issues: { nodes: [] } } }),
);
// Linear SDK: used by getInProgressIssues() and checkOpenPRs() via client.issues()
const mockLinearIssues = mock(() => Promise.resolve({ nodes: [] }));
// Linear SDK: used by updateIssue() in linear.ts via client.updateIssue()
const mockLinearUpdateIssue = mock(() => Promise.resolve({ success: true }));
// Linear SDK: used by updateIssue() in linear.ts via client.createComment()
const mockLinearCreateComment = mock(() =>
  Promise.resolve({ success: true, comment: null }),
);

// Agent SDK: controls whether query() returns a success or error iterable
const mockQuery = mock(
  () => makeSuccessIterable() as unknown as AsyncIterable<unknown> & { close(): void },
);

// GitHub (Octokit): controls what getPRStatus() sees
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
const mockListReviews = mock(() => Promise.resolve({ data: [] }));
const mockListReviewComments = mock(() => Promise.resolve({ data: [] }));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Use unique IDs per test to avoid contaminating the module-scoped
// activeIssueIds set in executor.ts across concurrent test runs.
let issueCounter = 0;
let prCounter = 3000; // High range to avoid conflict with monitor.test.ts numbers

function makeIssue() {
  issueCounter++;
  return {
    id: `int-issue-${issueCounter}`,
    identifier: `INT-${issueCounter}`,
    title: `Integration Issue ${issueCounter}`,
  };
}

function nextPrNumber() {
  return ++prCounter;
}

function makeConfig(
  executorOverrides: Partial<AutopilotConfig["executor"]> = {},
): AutopilotConfig {
  return {
    linear: {
      team: "INT",
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
      // Set timeouts to 0 so if(opts.timeoutMs) and if(opts.inactivityMs)
      // are falsy — no real timers are created during tests.
      timeout_minutes: 0,
      fixer_timeout_minutes: 0,
      max_fixer_attempts: 3,
      max_retries: 3,
      inactivity_timeout_minutes: 0,
      poll_interval_minutes: 5,
      stale_timeout_minutes: 15,
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
      timeout_minutes: 0,
      inactivity_timeout_minutes: 0,
      model: "opus",
    },
    projects: {
      enabled: true,
      poll_interval_minutes: 10,
      backlog_review_interval_minutes: 240,
      max_active_projects: 5,
      timeout_minutes: 0,
      model: "opus",
    },
    monitor: {
      respond_to_reviews: false,
      review_responder_timeout_minutes: 0,
    },
    github: { repo: "", automerge: false },
    persistence: {
      enabled: false,
      db_path: ".claude/autopilot.db",
      retention_days: 30,
    },
    // Disable sandbox so runClaude() skips mkdtempSync / buildSandboxConfig
    sandbox: {
      enabled: false,
      auto_allow_bash: true,
      network_restricted: false,
      extra_allowed_domains: [],
    },
    reviewer: {
      enabled: false,
      min_interval_minutes: 120,
      min_runs_before_review: 10,
      timeout_minutes: 0,
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
    teamKey: "INT",
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
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset singleton clients so they are recreated from the mocked constructors
  // on the next call to getLinearClient() / getLinearClientAsync() / getOctokit().
  resetSpawnGate();
  resetGithubClient();
  resetLinearClient();
  resetHandledReviewIds();

  // Reset GitHub mock state to safe defaults
  prData = {
    merged: false,
    mergeable: null,
    head: { ref: "feature/test", sha: "abc123" },
  };
  checkRunsData = { check_runs: [] };
  mockPullsGet.mockImplementation(() => Promise.resolve({ data: prData }));
  mockChecksListForRef.mockImplementation(() =>
    Promise.resolve({ data: checkRunsData }),
  );

  // Reset Linear mock state
  mockRawRequest.mockResolvedValue({ data: { issues: { nodes: [] } } });
  mockLinearIssues.mockResolvedValue({ nodes: [] });
  mockLinearUpdateIssue.mockResolvedValue({ success: true });
  mockLinearCreateComment.mockResolvedValue({ success: true, comment: null });

  // Default agent result: success (empty iterable completes immediately)
  mockQuery.mockImplementation(() => makeSuccessIterable() as unknown as AsyncIterable<unknown> & { close(): void });

  // Override _worktree functions to skip real git worktree creation/removal.
  // The _worktree object in claude.ts is intentionally mutable for exactly this purpose.
  _worktree.createWorktree = async (cwd: string) => cwd;
  _worktree.removeWorktree = async () => {};

  // ---------------------------------------------------------------------------
  // Mock external SDK packages at the lowest level so all internal modules
  // (executor.ts, monitor.ts, claude.ts, agent-config.ts, linear.ts, github.ts)
  // execute their real code paths — only HTTP calls and subprocess spawns are
  // replaced by test doubles.
  // ---------------------------------------------------------------------------

  // @anthropic-ai/claude-agent-sdk: replace query() (used by runClaude()) and
  // the tool-building helpers (used by buildMcpServers() in agent-config.ts).
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: mockQuery,
    // createSdkMcpServer and tool are called by buildMcpServers() to construct
    // the autopilot MCP server definition. The result is passed to query() which
    // we mock, so these just need to return non-null objects.
    createSdkMcpServer: (opts: Record<string, unknown>) => ({
      type: "sdk_mcp_server",
      ...opts,
    }),
    tool: (
      name: string,
      _desc: string,
      _schema: unknown,
      fn: unknown,
    ) => ({ name, fn }),
  }));

  // @linear/sdk: replace LinearClient so getLinearClient() / getLinearClientAsync()
  // create mock clients. The mock provides the methods called by:
  //   getReadyIssues()     → client.client.rawRequest()
  //   getInProgressIssues() → client.issues()
  //   checkOpenPRs()       → client.issues()
  //   updateIssue()        → client.updateIssue() + client.createComment()
  mock.module("@linear/sdk", () => ({
    LinearClient: class MockLinearClient {
      client = { rawRequest: mockRawRequest };
      issues = mockLinearIssues;
      updateIssue = mockLinearUpdateIssue;
      createComment = mockLinearCreateComment;
    },
    // Enum referenced in createProjectStatusUpdate() — not called in these tests
    ProjectUpdateHealthType: {},
  }));

  // octokit: replace Octokit so getOctokit() in github.ts creates a mock client.
  // The mock provides the REST methods called by getPRStatus() and getPRReviewInfo().
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
});

afterEach(() => {
  mock.restore();
  resetLinearClient();
  resetGithubClient();
});

// Restore the real module bindings after all integration tests complete so
// subsequent test files see unmodified modules. mock.restore() does NOT undo
// mock.module() in Bun 1.3.9 — must be done explicitly here.
afterAll(() => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    ..._realSdkSnapshot,
  }));
  mock.module("@linear/sdk", () => ({ ..._realLinearSdkSnapshot }));
  mock.module("octokit", () => ({ ..._realOctokitSnapshot }));
});

// ---------------------------------------------------------------------------
// Integration: executor success path
//
// Exercises the full chain:
//   fillSlots() → getReadyIssues() [real, via mocked LinearClient.rawRequest]
//     → executeIssue() [real]
//       → buildPrompt("executor", ...) [real, reads prompts/executor.md]
//       → buildAgentEnv() [real, reads process.env allowlist]
//       → buildQueryOptions() [real, assembles SDK options]
//       → _worktree.createWorktree [mocked: no-op]
//       → query() [mocked: empty iterable → success]
//       → handleAgentResult() [real, classifies result as "completed"]
//       → updateIssue(in_progress) [real linear.ts code, via mocked LinearClient]
// ---------------------------------------------------------------------------

describe("Integration: executor success path", () => {
  test("fillSlots → executeIssue → real buildPrompt/buildAgentEnv/buildQueryOptions/handleAgentResult → Linear updated to in_progress", async () => {
    const issue = makeIssue();
    const state = new AppState();
    const config = makeConfig();

    // Return one ready leaf issue from the mocked Linear GraphQL query
    mockRawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              priority: null,
              relations: { nodes: [] },
              children: { nodes: [] },
            },
          ],
        },
      },
    });
    mockLinearUpdateIssue.mockClear();

    const promises = await fillSlots({
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // fillSlots should have started exactly one agent for the one ready issue
    expect(promises).toHaveLength(1);

    // Wait for the agent to complete
    const results = await Promise.all(promises);
    expect(results[0]).toBe(true);

    // handleAgentResult() classified the completed (no-error) run as "completed"
    const history = state.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");

    // executeIssue() must move the issue to In Progress before invoking Claude
    const inProgressCall = mockLinearUpdateIssue.mock.calls.find(
      (call) =>
        Array.isArray(call) &&
        call[1] != null &&
        (call[1] as { stateId?: string }).stateId === "in-progress-id",
    );
    expect(inProgressCall).toBeDefined();

    // No ghost agents: agent was cleaned up after completion
    expect(state.getRunningCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: executor failure path
//
// Exercises:
//   executeIssue() [real]
//     → query() [mocked: throws → runClaude() sets result.error]
//     → handleAgentResult() [real, classifies as "failed"]
//     → retry logic [real, in executeIssue()]
//       - first failure → updateIssue(ready) for retry
//       - max_retries reached → updateIssue(blocked) + createComment
// ---------------------------------------------------------------------------

describe("Integration: executor failure path", () => {
  test("query() error → handleAgentResult(failed) → issue moved to ready for retry", async () => {
    const issue = makeIssue();
    const state = new AppState();
    const config = makeConfig({ max_retries: 3 });

    // Make query() throw — triggers the catch block in runClaude() which sets
    // result.error, causing handleAgentResult() to return { status: "failed" }
    mockQuery.mockImplementation(() => makeErrorIterable("agent subprocess crashed") as unknown as AsyncIterable<unknown> & { close(): void });
    mockLinearUpdateIssue.mockClear();

    const result = await executeIssue({
      issue,
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // Execution failed — executeIssue returns false
    expect(result).toBe(false);

    // handleAgentResult() classified the run as "failed"
    expect(state.getHistory()).toHaveLength(1);
    expect(state.getHistory()[0].status).toBe("failed");

    // First failure (failureCount=1 < max_retries=3): move to Ready for retry
    const readyCall = mockLinearUpdateIssue.mock.calls.find(
      (call) =>
        Array.isArray(call) &&
        call[1] != null &&
        (call[1] as { stateId?: string }).stateId === "ready-id",
    );
    expect(readyCall).toBeDefined();
  });

  test("query() error on max_retries → issue moved to blocked with comment", async () => {
    const issue = makeIssue();
    const state = new AppState();
    // Use max_retries=2 so two calls exhaust the budget
    const config = makeConfig({ max_retries: 2 });

    mockQuery.mockImplementation(() => makeErrorIterable("agent subprocess crashed") as unknown as AsyncIterable<unknown> & { close(): void });
    mockLinearUpdateIssue.mockClear();
    mockLinearCreateComment.mockClear();

    // First attempt: failureCount=1 < max_retries=2 → moves to Ready
    await executeIssue({
      issue,
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // Second attempt: failureCount=2 >= max_retries=2 → moves to Blocked + comment
    await executeIssue({
      issue,
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // Moved to Blocked after exhausting retries
    const blockedCall = mockLinearUpdateIssue.mock.calls.find(
      (call) =>
        Array.isArray(call) &&
        call[1] != null &&
        (call[1] as { stateId?: string }).stateId === "blocked-id",
    );
    expect(blockedCall).toBeDefined();

    // A comment explaining the failure must be posted to Linear
    expect(mockLinearCreateComment).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration: monitor fixer path
//
// Exercises:
//   checkOpenPRs() [real]
//     → getLinearClient() [real linear.ts, via mocked LinearClient]
//     → client.issues() [mocked] → issues with attachments()
//     → issue.attachments() [mocked on issue object] → PR URL
//     → getPRStatus() [real github.ts, via mocked Octokit]
//     → CI failure detected → fixPR() [real monitor.ts]
//       → buildPrompt("fixer", ...) [real, reads prompts/fixer.md]
//       → runClaude() [real claude.ts]
//         → _worktree.createWorktree [mocked: no-op]
//         → query() [mocked: empty iterable → success]
//       → handleAgentResult() [real, classifies as "completed"]
//     → no ghost agents in AppState after completion
// ---------------------------------------------------------------------------

describe("Integration: monitor fixer path", () => {
  test("checkOpenPRs detects CI failure → fixPR → real buildPrompt/runClaude/handleAgentResult → no ghost agents", async () => {
    const prNumber = nextPrNumber();
    const state = new AppState();
    const config = makeConfig();

    // Configure Linear to return one "In Review" issue with a GitHub PR attachment
    const monitorIssue = {
      id: `mon-issue-${prNumber}`,
      identifier: `MON-${prNumber}`,
      title: `Monitor Issue ${prNumber}`,
      attachments: mock(() =>
        Promise.resolve({
          nodes: [
            {
              sourceType: "github",
              url: `https://github.com/testowner/testrepo/pull/${prNumber}`,
            },
          ],
        }),
      ),
    };
    mockLinearIssues.mockResolvedValue({ nodes: [monitorIssue] });

    // Configure Octokit to report a CI failure on the PR
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: `feature/mon-${prNumber}`, sha: "def456" },
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "tests" },
      ],
    };
    mockPullsGet.mockImplementation(() => Promise.resolve({ data: prData }));
    mockChecksListForRef.mockImplementation(() =>
      Promise.resolve({ data: checkRunsData }),
    );

    const promises = await checkOpenPRs({
      owner: "testowner",
      repo: "testrepo",
      config,
      projectPath: "/project",
      linearIds: makeLinearIds(),
      state,
    });

    // checkOpenPRs must spawn exactly one fixer for the CI failure
    expect(promises).toHaveLength(1);

    // Wait for the fixer agent to complete
    await Promise.all(promises);

    // The fixer agent was registered in state and completed — no ghost agents
    expect(state.getRunningCount()).toBe(0);
    const history = state.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
  });
});
