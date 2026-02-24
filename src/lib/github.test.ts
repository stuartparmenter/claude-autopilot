import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Set a fake token so getGitHubClient() doesn't throw during tests
process.env.GITHUB_TOKEN = "test-token-github";

// Mutable state that controls what mock functions return.
// By mutating these objects before each test we avoid the mockImplementation
// reliability issues in Bun 1.3.9.
let prData: Record<string, unknown> = {
  merged: false,
  mergeable: true,
  head: { ref: "feature/test", sha: "abc123" },
};
let combinedStatusData: Record<string, unknown> = {
  state: "success",
  statuses: [],
};
let checkRunsData: Record<string, unknown> = { check_runs: [] };

const mockPullsGet = mock(() => Promise.resolve({ data: prData }));
const mockGetCombinedStatus = mock(() =>
  Promise.resolve({ data: combinedStatusData }),
);
const mockChecksListForRef = mock(() =>
  Promise.resolve({ data: checkRunsData }),
);

// Mock octokit BEFORE importing github.ts so the Octokit constructor is replaced
mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: { get: mockPullsGet },
      repos: { getCombinedStatusForRef: mockGetCombinedStatus },
      checks: { listForRef: mockChecksListForRef },
    };
  },
}));

import { detectRepo, getPRStatus } from "./github";

// ---------------------------------------------------------------------------
// detectRepo — config override path (no Bun.spawnSync needed)
// ---------------------------------------------------------------------------

describe("detectRepo — config override", () => {
  test("splits owner/repo correctly", () => {
    expect(detectRepo("/project", "myowner/myrepo")).toEqual({
      owner: "myowner",
      repo: "myrepo",
    });
  });

  test("owner/repo/extra returns first two segments (documents current behavior)", () => {
    expect(detectRepo("/project", "myowner/myrepo/extra")).toEqual({
      owner: "myowner",
      repo: "myrepo",
    });
  });

  test("throws when override has no slash", () => {
    expect(() => detectRepo("/project", "justowner")).toThrow(
      'Invalid github.repo config: "justowner"',
    );
  });

  test("throws when override has trailing slash (empty repo)", () => {
    expect(() => detectRepo("/project", "myowner/")).toThrow(
      'Invalid github.repo config: "myowner/"',
    );
  });

  test("throws when override has leading slash (empty owner)", () => {
    expect(() => detectRepo("/project", "/myrepo")).toThrow(
      'Invalid github.repo config: "/myrepo"',
    );
  });
});

// ---------------------------------------------------------------------------
// detectRepo — git remote parsing (mock Bun.spawnSync)
// ---------------------------------------------------------------------------

describe("detectRepo — git remote parsing", () => {
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, "spawnSync");
  });

  test("parses HTTPS remote URL correctly", () => {
    spawnSpy.mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("https://github.com/owner/repo.git\n"),
      stderr: Buffer.from(""),
      success: true,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(detectRepo("/project")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("parses SSH remote URL correctly", () => {
    spawnSpy.mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("git@github.com:owner/repo.git\n"),
      stderr: Buffer.from(""),
      success: true,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(detectRepo("/project")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("throws on non-GitHub remote URL", () => {
    spawnSpy.mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("https://gitlab.com/owner/repo.git\n"),
      stderr: Buffer.from(""),
      success: true,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(() => detectRepo("/project")).toThrow("Could not parse");
  });

  test("throws when git remote command fails (exitCode !== 0)", () => {
    spawnSpy.mockReturnValue({
      exitCode: 128,
      stdout: Buffer.from(""),
      stderr: Buffer.from("not a git repo"),
      success: false,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(() => detectRepo("/project")).toThrow("Failed to detect");
  });

  test("HTTPS URL without .git suffix is parsed correctly", () => {
    spawnSpy.mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("https://github.com/orgname/myproject\n"),
      stderr: Buffer.from(""),
      success: true,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(detectRepo("/project")).toEqual({
      owner: "orgname",
      repo: "myproject",
    });
  });
});

// ---------------------------------------------------------------------------
// getPRStatus — CI status aggregation
// ---------------------------------------------------------------------------

describe("getPRStatus", () => {
  // Reset mutable mock state before each test to a safe "success/no-issues" baseline
  beforeEach(() => {
    prData = {
      merged: false,
      mergeable: true,
      head: { ref: "feature/test", sha: "abc123" },
    };
    combinedStatusData = { state: "success", statuses: [] };
    checkRunsData = { check_runs: [] };
  });

  test("merged PR returns merged:true with ciStatus:success", async () => {
    prData = {
      merged: true,
      mergeable: null,
      head: { ref: "feature/done", sha: "def456" },
    };

    const status = await getPRStatus("owner", "repo", 42);

    expect(status.merged).toBe(true);
    expect(status.ciStatus).toBe("success");
    expect(status.ciDetails).toBe("");
  });

  test("all checks complete + status success returns ciStatus:success", async () => {
    combinedStatusData = {
      state: "success",
      statuses: [{ state: "success", context: "lint", description: "ok" }],
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "tests" },
      ],
    };

    const status = await getPRStatus("owner", "repo", 1);

    expect(status.merged).toBe(false);
    expect(status.ciStatus).toBe("success");
  });

  test("timed_out check conclusion is treated as failure", async () => {
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "timed_out", name: "slow-tests" },
      ],
    };

    const status = await getPRStatus("owner", "repo", 2);

    expect(status.ciStatus).toBe("failure");
    expect(status.ciDetails).toContain("slow-tests");
    expect(status.ciDetails).toContain("timed_out");
  });

  test("check run failure returns ciStatus:failure with check name", async () => {
    combinedStatusData = {
      state: "success",
      statuses: [{ state: "success", context: "ci" }],
    };
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "failure", name: "unit-tests" },
      ],
    };

    const status = await getPRStatus("owner", "repo", 3);

    expect(status.ciStatus).toBe("failure");
    expect(status.ciDetails).toContain("unit-tests");
    expect(status.ciDetails).toContain("failure");
  });

  test("pending check run returns ciStatus:pending", async () => {
    combinedStatusData = {
      state: "success",
      statuses: [{ state: "success", context: "ci" }],
    };
    checkRunsData = {
      check_runs: [{ status: "in_progress", conclusion: null, name: "tests" }],
    };

    const status = await getPRStatus("owner", "repo", 4);

    expect(status.ciStatus).toBe("pending");
  });

  test("mix of completed and in-progress checks returns ciStatus:pending", async () => {
    checkRunsData = {
      check_runs: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "in_progress", conclusion: null, name: "tests" },
      ],
    };

    const status = await getPRStatus("owner", "repo", 5);

    expect(status.ciStatus).toBe("pending");
  });

  test("mergeable:null passes through unchanged", async () => {
    prData = {
      merged: false,
      mergeable: null,
      head: { ref: "feature/test", sha: "abc123" },
    };

    const status = await getPRStatus("owner", "repo", 6);

    expect(status.mergeable).toBeNull();
  });

  test("mergeable:false passes through unchanged", async () => {
    prData = {
      merged: false,
      mergeable: false,
      head: { ref: "feature/test", sha: "abc123" },
    };

    const status = await getPRStatus("owner", "repo", 7);

    expect(status.mergeable).toBe(false);
  });

  test("empty checks array returns ciStatus:pending (no signals yet)", async () => {
    checkRunsData = { check_runs: [] };

    const status = await getPRStatus("owner", "repo", 8);

    expect(status.ciStatus).toBe("pending");
  });

  test("returns branch name from PR head", async () => {
    prData = {
      merged: false,
      mergeable: true,
      head: { ref: "feature/my-branch", sha: "xyz" },
    };

    const status = await getPRStatus("owner", "repo", 9);

    expect(status.branch).toBe("feature/my-branch");
  });
});
