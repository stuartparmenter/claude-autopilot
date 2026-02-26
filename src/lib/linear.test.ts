import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { LinearIds } from "./config";
import {
  countIssuesInState,
  findOrCreateLabel,
  findState,
  findTeam,
  getLinearClient,
  getReadyIssues,
  getTriageIssues,
  createIssue as linearCreateIssue,
  updateIssue as linearUpdateIssue,
  resetClient,
  resolveLinearIds,
  setClientForTesting,
  validateIdentifier,
} from "./linear";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const TEST_IDS: LinearIds = {
  teamId: "team-1",
  teamKey: "ENG",
  states: {
    triage: "s1",
    ready: "s2",
    in_progress: "s3",
    in_review: "s4",
    done: "s5",
    blocked: "s6",
  },
};

const LINEAR_CONFIG = {
  team: "ENG",
  initiative: "Test Initiative",
  states: {
    triage: "Triage",
    ready: "Ready",
    in_progress: "In Progress",
    in_review: "In Review",
    done: "Done",
    blocked: "Blocked",
  },
};

// ---------------------------------------------------------------------------
// MockPage type and helpers (for countIssuesInState pagination tests)
// ---------------------------------------------------------------------------

interface MockPage {
  nodes: { id: string }[];
  pageInfo: { hasNextPage: boolean };
  fetchNext: () => Promise<MockPage>;
}

function makePage(
  nodeCount: number,
  hasNextPage: boolean,
  fetchNext?: () => Promise<MockPage>,
): MockPage {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `item-${i}` })),
    pageInfo: { hasNextPage },
    fetchNext:
      fetchNext ??
      (async () => {
        throw new Error("unexpected fetchNext call");
      }),
  };
}

// ---------------------------------------------------------------------------
// Issue / relation helpers (for getReadyIssues tests)
// ---------------------------------------------------------------------------

function makeIssue(opts: {
  id?: string;
  identifier?: string;
  priority?: number | undefined;
  relationsResult?: { nodes: unknown[] };
  relationsError?: Error;
  childrenNodes?: unknown[];
}): unknown {
  return {
    id: opts.id ?? "issue-1",
    identifier: opts.identifier ?? "ENG-1",
    title: "Test Issue",
    priority: opts.priority,
    relations: opts.relationsError
      ? () => Promise.reject(opts.relationsError)
      : () => Promise.resolve(opts.relationsResult ?? { nodes: [] }),
    children: () => Promise.resolve({ nodes: opts.childrenNodes ?? [] }),
  };
}

function makeRelation(type: string, relatedIssue: unknown): unknown {
  return {
    type,
    // relatedIssue is accessed with `async () => relation.relatedIssue`, so
    // wrapping it in a Promise means it gets double-awaited to the inner value.
    relatedIssue: Promise.resolve(relatedIssue),
  };
}

function makeRelatedIssue(stateType: string | null): unknown {
  return {
    id: "related-1",
    identifier: "ENG-99",
    state: Promise.resolve(
      stateType !== null ? { id: `state-${stateType}`, type: stateType } : null,
    ),
  };
}

// ---------------------------------------------------------------------------
// Module-level mock state and functions (shared across describe blocks)
// ---------------------------------------------------------------------------

let mockTeamsNodes: unknown[] = [];
let mockProjectsNodes: unknown[] = [];
let mockWorkflowStatesNodes: unknown[] = [];
let mockIssuesNodes: unknown[] = [];
let mockIssueLabelsNodes: unknown[] = [];
let mockInitiativesNodes: unknown[] = [];
let mockCreateIssueLabelData: unknown = null;
let mockCreateIssueData: unknown = null;

const mockTeams = mock(() => Promise.resolve({ nodes: mockTeamsNodes }));
const mockProjects = mock(() => Promise.resolve({ nodes: mockProjectsNodes }));
const mockInitiatives = mock(() =>
  Promise.resolve({ nodes: mockInitiativesNodes }),
);
// Accepts an optional arg so mockImplementation callbacks can read filter args
const mockWorkflowStates = mock((_args?: unknown) =>
  Promise.resolve({ nodes: mockWorkflowStatesNodes }),
);
const mockIssuesForReady = mock(() =>
  Promise.resolve({
    nodes: mockIssuesNodes,
    pageInfo: { hasNextPage: false },
    fetchNext: async () => ({ nodes: [], pageInfo: { hasNextPage: false } }),
  }),
);
const mockIssueLabels = mock(() =>
  Promise.resolve({ nodes: mockIssueLabelsNodes }),
);
const mockCreateIssueLabel = mock(() =>
  Promise.resolve({ issueLabel: Promise.resolve(mockCreateIssueLabelData) }),
);
const mockCreateIssueFn = mock(() =>
  Promise.resolve({ issue: Promise.resolve(mockCreateIssueData) }),
);
const mockUpdateIssue = mock(() => Promise.resolve({}));
const mockCreateComment = mock(() => Promise.resolve({}));

/** Build a mock LinearClient that delegates to the module-level mock functions. */
function makeStandardClient(): LinearClient {
  return {
    teams: mockTeams,
    projects: mockProjects,
    initiatives: mockInitiatives,
    workflowStates: mockWorkflowStates,
    issues: mockIssuesForReady,
    issueLabels: mockIssueLabels,
    createIssueLabel: mockCreateIssueLabel,
    createIssue: mockCreateIssueFn,
    updateIssue: mockUpdateIssue,
    createComment: mockCreateComment,
    get viewer() {
      return Promise.resolve({ name: "Test User", email: "test@example.com" });
    },
  } as unknown as LinearClient;
}

// ---------------------------------------------------------------------------
// getLinearClient / resetClient
// ---------------------------------------------------------------------------

describe("getLinearClient", () => {
  beforeEach(() => {
    resetClient();
    process.env.LINEAR_API_KEY = "test-linear-key";
  });

  test("returns a client instance when LINEAR_API_KEY is set", () => {
    const client = getLinearClient();
    expect(client).toBeDefined();
  });

  test("returns the same instance on subsequent calls (singleton)", () => {
    const a = getLinearClient();
    const b = getLinearClient();
    expect(a).toBe(b);
  });

  test("throws with helpful message when LINEAR_API_KEY is missing", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => getLinearClient()).toThrow("LINEAR_API_KEY");
  });

  test("returns a new instance after resetClient()", () => {
    const a = getLinearClient();
    resetClient();
    const b = getLinearClient();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// findTeam
// ---------------------------------------------------------------------------

describe("findTeam", () => {
  beforeEach(() => {
    mockTeamsNodes = [];
    mockTeams.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns the team when found", async () => {
    const team = { id: "team-1", key: "ENG", name: "Engineering" };
    mockTeamsNodes = [team];

    const result = await findTeam("ENG");

    expect(result).toMatchObject(team);
    expect(mockTeams).toHaveBeenCalledWith({ filter: { key: { eq: "ENG" } } });
  });

  test("throws descriptive error when team not found", async () => {
    mockTeamsNodes = [];

    await expect(findTeam("NONE")).rejects.toThrow(
      "Team 'NONE' not found in Linear",
    );
  });
});

// ---------------------------------------------------------------------------
// findState
// ---------------------------------------------------------------------------

describe("findState", () => {
  beforeEach(() => {
    mockWorkflowStatesNodes = [];
    mockWorkflowStates.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns the workflow state when found", async () => {
    const state = { id: "state-1", name: "Ready", type: "triage" };
    mockWorkflowStatesNodes = [state];

    const result = await findState("team-1", "Ready");

    expect(result).toMatchObject(state);
    expect(mockWorkflowStates).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: "team-1" } },
        name: { eq: "Ready" },
      },
    });
  });

  test("throws descriptive error when state not found", async () => {
    mockWorkflowStatesNodes = [];

    await expect(findState("team-1", "Ghost")).rejects.toThrow(
      "State 'Ghost' not found for team",
    );
  });
});

// ---------------------------------------------------------------------------
// findOrCreateLabel
// ---------------------------------------------------------------------------

describe("findOrCreateLabel", () => {
  beforeEach(() => {
    mockIssueLabelsNodes = [];
    mockCreateIssueLabelData = null;
    mockIssueLabels.mockClear();
    mockCreateIssueLabel.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns existing label without calling createIssueLabel", async () => {
    const label = { id: "lbl-1", name: "bug", color: "#ff0000" };
    mockIssueLabelsNodes = [label];

    const result = await findOrCreateLabel("team-1", "bug");

    expect(result).toMatchObject(label);
    expect(mockCreateIssueLabel).not.toHaveBeenCalled();
  });

  test("creates label with default color when not found", async () => {
    const label = { id: "lbl-2", name: "feature", color: "#888888" };
    mockIssueLabelsNodes = [];
    mockCreateIssueLabelData = label;

    const result = await findOrCreateLabel("team-1", "feature");

    expect(result).toMatchObject(label);
    expect(mockCreateIssueLabel).toHaveBeenCalledWith({
      teamId: "team-1",
      name: "feature",
      color: "#888888",
    });
  });

  test("uses custom color when provided", async () => {
    const label = { id: "lbl-3", name: "custom", color: "#abc123" };
    mockIssueLabelsNodes = [];
    mockCreateIssueLabelData = label;

    await findOrCreateLabel("team-1", "custom", "#abc123");

    expect(mockCreateIssueLabel).toHaveBeenCalledWith({
      teamId: "team-1",
      name: "custom",
      color: "#abc123",
    });
  });

  test("throws when label creation returns null", async () => {
    mockIssueLabelsNodes = [];
    mockCreateIssueLabelData = null;

    await expect(findOrCreateLabel("team-1", "missing")).rejects.toThrow(
      "Failed to create label 'missing'",
    );
  });
});

// ---------------------------------------------------------------------------
// getReadyIssues
// ---------------------------------------------------------------------------

describe("getReadyIssues", () => {
  beforeEach(() => {
    mockIssuesNodes = [];
    mockIssuesForReady.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns empty array when no issues exist", async () => {
    const result = await getReadyIssues(TEST_IDS);
    expect(result).toEqual([]);
  });

  test("passes correct filter and limit to API", async () => {
    await getReadyIssues(TEST_IDS, 5);

    expect(mockIssuesForReady).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: TEST_IDS.teamId } },
        state: { id: { eq: TEST_IDS.states.ready } },
      },
      first: 5,
    });
  });

  test("default limit is 10", async () => {
    await getReadyIssues(TEST_IDS);

    expect(mockIssuesForReady).toHaveBeenCalledWith(
      expect.objectContaining({ first: 10 }),
    );
  });

  test("sorts issues by priority (lower number = higher priority)", async () => {
    mockIssuesNodes = [
      makeIssue({ id: "c", priority: 3 }),
      makeIssue({ id: "a", priority: 1 }),
      makeIssue({ id: "b", priority: 2 }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result.map((i: unknown) => (i as { id: string }).id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("treats undefined priority as 4 (lowest) when sorting", async () => {
    mockIssuesNodes = [
      makeIssue({ id: "no-pri", priority: undefined }),
      makeIssue({ id: "high", priority: 1 }),
      makeIssue({ id: "med", priority: 3 }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result.map((i: unknown) => (i as { id: string }).id)).toEqual([
      "high",
      "med",
      "no-pri",
    ]);
  });

  test("returns unblocked issue that has no relations", async () => {
    mockIssuesNodes = [makeIssue({ id: "free" })];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("free");
  });

  test("filters out issue blocked by incomplete issue (state type 'started')", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "blocked",
        relationsResult: {
          nodes: [makeRelation("blocks", makeRelatedIssue("started"))],
        },
      }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(0);
  });

  test("includes issue when blocking relation's relatedIssue is completed", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "done-blocker",
        relationsResult: {
          nodes: [makeRelation("blocks", makeRelatedIssue("completed"))],
        },
      }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("done-blocker");
  });

  test("includes issue when blocking relation's relatedIssue is canceled", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "canceled-blocker",
        relationsResult: {
          nodes: [makeRelation("blocks", makeRelatedIssue("canceled"))],
        },
      }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
  });

  test("ignores non-'blocks' relation types (does not block execution)", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "related-only",
        relationsResult: {
          nodes: [makeRelation("related", makeRelatedIssue("started"))],
        },
      }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
  });

  test("handles null relatedIssue gracefully (treats as not blocking)", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "null-related",
        relationsResult: {
          nodes: [makeRelation("blocks", null)],
        },
      }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
  });

  test("skips issue on relation fetch error and continues to next issue", async () => {
    mockIssuesNodes = [
      makeIssue({
        id: "error-issue",
        relationsError: new Error("Network failure"),
      }),
      makeIssue({ id: "good-issue" }),
    ];

    const result = await getReadyIssues(TEST_IDS);

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("good-issue");
  });
});

// ---------------------------------------------------------------------------
// getTriageIssues
// ---------------------------------------------------------------------------

describe("getTriageIssues", () => {
  beforeEach(() => {
    mockIssuesNodes = [];
    mockIssuesForReady.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns empty array when no triage issues exist", async () => {
    const result = await getTriageIssues(TEST_IDS);
    expect(result).toEqual([]);
  });

  test("passes correct filter and limit to API", async () => {
    await getTriageIssues(TEST_IDS, 25);

    expect(mockIssuesForReady).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: TEST_IDS.teamId } },
        state: { id: { eq: TEST_IDS.states.triage } },
      },
      first: 25,
    });
  });

  test("default limit is 50", async () => {
    await getTriageIssues(TEST_IDS);

    expect(mockIssuesForReady).toHaveBeenCalledWith(
      expect.objectContaining({ first: 50 }),
    );
  });

  test("sorts issues by priority ascending (lower number = higher priority)", async () => {
    mockIssuesNodes = [
      makeIssue({ id: "c", priority: 3 }),
      makeIssue({ id: "a", priority: 1 }),
      makeIssue({ id: "b", priority: 2 }),
    ];

    const result = await getTriageIssues(TEST_IDS);

    expect(result.map((i: unknown) => (i as { id: string }).id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("treats undefined priority as 4 (lowest) when sorting", async () => {
    mockIssuesNodes = [
      makeIssue({ id: "no-pri", priority: undefined }),
      makeIssue({ id: "high", priority: 1 }),
    ];

    const result = await getTriageIssues(TEST_IDS);

    expect(result.map((i: unknown) => (i as { id: string }).id)).toEqual([
      "high",
      "no-pri",
    ]);
  });
});

// ---------------------------------------------------------------------------
// countIssuesInState
// ---------------------------------------------------------------------------

// Mutable reference: each test sets this before calling countIssuesInState.
// We use a mutable variable instead of mockImplementation to avoid the
// mockImplementation reliability issues in Bun 1.3.9 (see github.test.ts).
let currentPage: MockPage = makePage(0, false);
const mockIssues = mock(async () => currentPage);

describe("countIssuesInState", () => {
  beforeEach(() => {
    mockIssues.mockClear();
    // Inject the mock client directly to avoid @linear/sdk module-mock issues
    setClientForTesting({ issues: mockIssues } as unknown as LinearClient);
  });

  test("returns node count for a single-page result", async () => {
    currentPage = makePage(7, false);
    const count = await countIssuesInState(TEST_IDS, "state-id");
    expect(count).toBe(7);
  });

  test("accumulates count across multiple pages", async () => {
    const page2 = makePage(3, false);
    currentPage = makePage(5, true, async () => page2);
    const count = await countIssuesInState(TEST_IDS, "state-id");
    expect(count).toBe(8); // 5 + 3
  });

  test("retries fetchNext() on transient error and returns correct total", async () => {
    let fetchNextCalls = 0;
    const page2 = makePage(2, false);
    currentPage = makePage(3, true, async () => {
      fetchNextCalls++;
      if (fetchNextCalls === 1) {
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      }
      return page2;
    });

    // Suppress retry warning output from withRetry
    const originalLog = console.log;
    console.log = () => {};
    const count = await countIssuesInState(TEST_IDS, "state-id");
    console.log = originalLog;

    expect(count).toBe(5); // 3 + 2
    expect(fetchNextCalls).toBe(2); // failed once, then succeeded
  });

  test("stops pagination after MAX_PAGES and logs a warning", async () => {
    const warnMessages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string") warnMessages.push(args[0]);
    };

    // Create an infinite chain: every page reports hasNextPage true
    function makeInfinitePage(n: number): MockPage {
      return {
        nodes: [{ id: `item-${n}` }],
        pageInfo: { hasNextPage: true },
        fetchNext: async () => makeInfinitePage(n + 1),
      };
    }
    currentPage = makeInfinitePage(0);

    const count = await countIssuesInState(TEST_IDS, "state-id");
    console.log = originalLog;

    // MAX_PAGES is 100: initial page + 99 iterations = 100 pages × 1 node = 100
    expect(count).toBe(100);

    // A [WARN] message mentioning the page limit must have been logged
    const hasWarning = warnMessages.some(
      (msg) => msg.includes("[WARN]") && msg.includes("page limit"),
    );
    expect(hasWarning).toBe(true);
  });

  test("returns 0 for empty state", async () => {
    currentPage = makePage(0, false);
    const count = await countIssuesInState(TEST_IDS, "state-empty");
    expect(count).toBe(0);
  });

  test("passes correct filter to API", async () => {
    currentPage = makePage(0, false);
    await countIssuesInState(TEST_IDS, "state-xyz");

    expect(mockIssues).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: TEST_IDS.teamId } },
        state: { id: { eq: "state-xyz" } },
      },
      first: 250,
    });
  });
});

// ---------------------------------------------------------------------------
// updateIssue
// ---------------------------------------------------------------------------

describe("updateIssue", () => {
  beforeEach(() => {
    mockUpdateIssue.mockClear();
    mockCreateComment.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("updates state when stateId provided", async () => {
    await linearUpdateIssue("issue-1", { stateId: "state-done" });

    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-done",
    });
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("creates comment when comment provided", async () => {
    await linearUpdateIssue("issue-1", { comment: "Done!" });

    expect(mockCreateComment).toHaveBeenCalledWith({
      issueId: "issue-1",
      body: "Done!",
    });
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  test("updates state and adds comment when both provided", async () => {
    await linearUpdateIssue("issue-1", {
      stateId: "state-done",
      comment: "Done!",
    });

    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-1", {
      stateId: "state-done",
    });
    expect(mockCreateComment).toHaveBeenCalledWith({
      issueId: "issue-1",
      body: "Done!",
    });
  });

  test("calls neither updateIssue nor createComment when opts is empty", async () => {
    await linearUpdateIssue("issue-1", {});

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe("createIssue", () => {
  beforeEach(() => {
    mockCreateIssueData = null;
    mockCreateIssueFn.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("creates issue with all fields and returns it", async () => {
    const created = { id: "new-1", title: "New Issue" };
    mockCreateIssueData = created;

    const result = await linearCreateIssue({
      teamId: "team-1",
      projectId: "proj-1",
      title: "New Issue",
      description: "desc",
      stateId: "state-1",
      priority: 2,
      labelIds: ["lbl-1"],
      parentId: "par-1",
    });

    expect(result).toMatchObject(created);
    expect(mockCreateIssueFn).toHaveBeenCalledWith({
      teamId: "team-1",
      projectId: "proj-1",
      title: "New Issue",
      description: "desc",
      stateId: "state-1",
      priority: 2,
      labelIds: ["lbl-1"],
      parentId: "par-1",
    });
  });

  test("creates issue with only required fields", async () => {
    const created = { id: "new-2", title: "Minimal" };
    mockCreateIssueData = created;

    const result = await linearCreateIssue({
      teamId: "team-1",
      projectId: "proj-1",
      title: "Minimal",
      description: "desc",
      stateId: "state-1",
    });

    expect(result).toMatchObject(created);
  });

  test("throws when creation returns null", async () => {
    mockCreateIssueData = null;

    await expect(
      linearCreateIssue({
        teamId: "team-1",
        projectId: "proj-1",
        title: "Fail",
        description: "desc",
        stateId: "state-1",
      }),
    ).rejects.toThrow("Failed to create issue");
  });
});

// ---------------------------------------------------------------------------
// validateIdentifier
// ---------------------------------------------------------------------------

describe("validateIdentifier", () => {
  test("accepts standard format 'ENG-42'", () => {
    expect(validateIdentifier("ENG-42")).toBe("ENG-42");
  });

  test("accepts multi-segment team key 'PLATFORM-1'", () => {
    expect(validateIdentifier("PLATFORM-1")).toBe("PLATFORM-1");
  });

  test("accepts single-character team key 'X-1'", () => {
    expect(validateIdentifier("X-1")).toBe("X-1");
  });

  test("accepts large issue number 'ENG-999999'", () => {
    expect(validateIdentifier("ENG-999999")).toBe("ENG-999999");
  });

  test("accepts alphanumeric team key 'ENG2-1'", () => {
    expect(validateIdentifier("ENG2-1")).toBe("ENG2-1");
  });

  test("rejects forward slash injection 'ENG-1/path'", () => {
    expect(() => validateIdentifier("ENG-1/path")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects backslash injection 'ENG-1\\path'", () => {
    expect(() => validateIdentifier("ENG-1\\path")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects space 'ENG 1'", () => {
    expect(() => validateIdentifier("ENG 1")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects semicolon injection 'ENG-1;rm'", () => {
    expect(() => validateIdentifier("ENG-1;rm")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects pipe injection 'ENG-1|ls'", () => {
    expect(() => validateIdentifier("ENG-1|ls")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects missing dash 'ENG1'", () => {
    expect(() => validateIdentifier("ENG1")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects missing number after dash 'ENG-'", () => {
    expect(() => validateIdentifier("ENG-")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects number-first '1-ENG'", () => {
    expect(() => validateIdentifier("1-ENG")).toThrow(
      "Invalid Linear issue identifier",
    );
  });

  test("rejects empty string", () => {
    expect(() => validateIdentifier("")).toThrow(
      "Invalid Linear issue identifier",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveLinearIds
// ---------------------------------------------------------------------------

describe("resolveLinearIds", () => {
  beforeEach(() => {
    mockTeamsNodes = [{ id: "team-123", key: "ENG" }];
    mockProjectsNodes = [{ id: "project-456", name: "Test Project" }];
    mockInitiativesNodes = [{ id: "init-789", name: "Test Initiative" }];
    mockWorkflowStatesNodes = [
      { id: "state-default", name: "State", type: "triage" },
    ];
    mockTeams.mockClear();
    mockProjects.mockClear();
    mockInitiatives.mockClear();
    mockWorkflowStates.mockClear();
    setClientForTesting(makeStandardClient());
  });

  test("returns correct LinearIds structure with all state IDs resolved", async () => {
    const stateMap: Record<string, string> = {
      Triage: "s-triage",
      Ready: "s-ready",
      "In Progress": "s-inprogress",
      "In Review": "s-inreview",
      Done: "s-done",
      Blocked: "s-blocked",
    };
    mockWorkflowStates.mockImplementation((args?: unknown) => {
      const name = (args as { filter: { name: { eq: string } } }).filter.name
        .eq;
      const id = stateMap[name] ?? "s-unknown";
      return Promise.resolve({ nodes: [{ id, name, type: "triage" }] });
    });

    try {
      const ids = await resolveLinearIds(LINEAR_CONFIG);

      expect(ids.teamId).toBe("team-123");
      expect(ids.teamKey).toBe("ENG");
      expect(ids.states.triage).toBe("s-triage");
      expect(ids.states.ready).toBe("s-ready");
      expect(ids.states.in_progress).toBe("s-inprogress");
      expect(ids.states.in_review).toBe("s-inreview");
      expect(ids.states.done).toBe("s-done");
      expect(ids.states.blocked).toBe("s-blocked");
    } finally {
      // Restore closure-based implementation for subsequent tests
      mockWorkflowStates.mockImplementation((_args?: unknown) =>
        Promise.resolve({ nodes: mockWorkflowStatesNodes }),
      );
    }
  });

  test("calls findState 6 times (once per workflow state)", async () => {
    await resolveLinearIds(LINEAR_CONFIG);

    expect(mockWorkflowStates).toHaveBeenCalledTimes(6);
  });

  test("propagates error when findTeam fails", async () => {
    mockTeamsNodes = [];

    await expect(
      resolveLinearIds({ ...LINEAR_CONFIG, team: "NOEXIST" }),
    ).rejects.toThrow("Team 'NOEXIST' not found");
  });

  test("propagates error when a findState call fails", async () => {
    mockWorkflowStatesNodes = []; // empty nodes → findState throws

    await expect(resolveLinearIds(LINEAR_CONFIG)).rejects.toThrow(
      "not found for team",
    );
  });
});
