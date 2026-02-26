import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import type { LinearIds } from "./config";
import { countIssuesInState, setClientForTesting } from "./linear";

// ---------------------------------------------------------------------------
// Mock page type and helpers
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

// Mutable reference: each test sets this before calling countIssuesInState.
// We use a mutable variable instead of mockImplementation to avoid the
// mockImplementation reliability issues in Bun 1.3.9 (see github.test.ts).
let currentPage: MockPage = makePage(0, false);
const mockIssues = mock(async () => currentPage);

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

// ---------------------------------------------------------------------------
// countIssuesInState
// ---------------------------------------------------------------------------

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
});
