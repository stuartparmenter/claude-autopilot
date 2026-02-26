import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "./lib/config";
import type { ActivityEntry } from "./state";
import { AppState } from "./state";

describe("AppState — agent lifecycle", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("initially has no running agents", () => {
    expect(state.getRunningAgents()).toEqual([]);
    expect(state.getRunningCount()).toBe(0);
  });

  test("addAgent creates a running agent", () => {
    state.addAgent("a1", "ISSUE-1", "Fix the bug");
    const agent = state.getAgent("a1");
    expect(agent).toBeDefined();
    expect(agent?.issueId).toBe("ISSUE-1");
    expect(agent?.issueTitle).toBe("Fix the bug");
    expect(agent?.status).toBe("running");
    expect(agent?.activities).toEqual([]);
  });

  test("multiple agents are tracked independently", () => {
    state.addAgent("a1", "ISSUE-1", "First");
    state.addAgent("a2", "ISSUE-2", "Second");
    expect(state.getRunningCount()).toBe(2);
    expect(state.getAgent("a1")?.issueId).toBe("ISSUE-1");
    expect(state.getAgent("a2")?.issueId).toBe("ISSUE-2");
  });

  test("getAgent returns undefined for unknown ID", () => {
    expect(state.getAgent("no-such-id")).toBeUndefined();
  });

  test("getRunningAgents returns all running agents as array", () => {
    state.addAgent("a1", "ISSUE-1", "First");
    state.addAgent("a2", "ISSUE-2", "Second");
    const agents = state.getRunningAgents();
    expect(agents.length).toBe(2);
    const ids = agents.map((a) => a.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("a2");
  });

  test("getRunningCount returns the number of active agents", () => {
    state.addAgent("a1", "ISSUE-1", "First");
    expect(state.getRunningCount()).toBe(1);
    state.addAgent("a2", "ISSUE-2", "Second");
    expect(state.getRunningCount()).toBe(2);
  });
});

describe("AppState — addActivity", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
    state.addAgent("a1", "ISSUE-1", "Test agent");
  });

  test("adds activity to the agent", () => {
    const entry: ActivityEntry = {
      timestamp: Date.now(),
      type: "text",
      summary: "hello",
    };
    state.addActivity("a1", entry);
    expect(state.getAgent("a1")?.activities).toHaveLength(1);
    expect(state.getAgent("a1")?.activities[0].summary).toBe("hello");
  });

  test("silently ignores unknown agent ID", () => {
    expect(() =>
      state.addActivity("no-such-agent", {
        timestamp: Date.now(),
        type: "text",
        summary: "x",
      }),
    ).not.toThrow();
  });

  test("caps activities at 200 entries per agent", () => {
    for (let i = 0; i < 210; i++) {
      state.addActivity("a1", {
        timestamp: Date.now(),
        type: "text",
        summary: `msg ${i}`,
      });
    }
    expect(state.getAgent("a1")?.activities.length).toBe(200);
  });

  test("keeps the most recent entries when trimming", () => {
    for (let i = 0; i < 210; i++) {
      state.addActivity("a1", {
        timestamp: Date.now(),
        type: "text",
        summary: `msg ${i}`,
      });
    }
    const activities = state.getAgent("a1")?.activities ?? [];
    expect(activities[0].summary).toBe("msg 10");
    expect(activities[199].summary).toBe("msg 209");
  });
});

describe("AppState — completeAgent", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("moves agent from running to history", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed");
    expect(state.getAgent("a1")).toBeUndefined();
    expect(state.getHistory().length).toBe(1);
    expect(state.getHistory()[0].issueId).toBe("ISSUE-1");
  });

  test("records correct status in history", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "failed");
    expect(state.getHistory()[0].status).toBe("failed");
  });

  test("records meta fields in history", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "failed", {
      costUsd: 0.5,
      durationMs: 30000,
      numTurns: 10,
      error: "something went wrong",
    });
    const result = state.getHistory()[0];
    expect(result.costUsd).toBe(0.5);
    expect(result.durationMs).toBe(30000);
    expect(result.numTurns).toBe(10);
    expect(result.error).toBe("something went wrong");
  });

  test("no-op for unknown agent ID", () => {
    expect(() => state.completeAgent("no-such-id", "completed")).not.toThrow();
    expect(state.getHistory().length).toBe(0);
  });

  test("history is capped at 50 entries", () => {
    for (let i = 0; i < 60; i++) {
      state.addAgent(`agent-${i}`, `ISSUE-${i}`, `Title ${i}`);
      state.completeAgent(`agent-${i}`, "completed");
    }
    expect(state.getHistory().length).toBe(50);
  });

  test("history is newest-first", () => {
    state.addAgent("a1", "ISSUE-1", "First");
    state.completeAgent("a1", "completed");
    state.addAgent("a2", "ISSUE-2", "Second");
    state.completeAgent("a2", "completed");
    const history = state.getHistory();
    expect(history[0].issueId).toBe("ISSUE-2");
    expect(history[1].issueId).toBe("ISSUE-1");
  });
});

describe("AppState — updateQueue", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("updates ready and in-progress counts", () => {
    state.updateQueue(5, 2);
    const snap = state.toJSON();
    expect(snap.queue.readyCount).toBe(5);
    expect(snap.queue.inProgressCount).toBe(2);
  });

  test("updates lastChecked timestamp", () => {
    const before = Date.now();
    state.updateQueue(3, 1);
    const after = Date.now();
    const snap = state.toJSON();
    expect(snap.queue.lastChecked).toBeGreaterThanOrEqual(before);
    expect(snap.queue.lastChecked).toBeLessThanOrEqual(after);
  });
});

describe("AppState — updatePlanning", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("initially planning is not running", () => {
    expect(state.getPlanningStatus().running).toBe(false);
  });

  test("partial update merges into planning status", () => {
    state.updatePlanning({ running: true });
    expect(state.getPlanningStatus().running).toBe(true);
  });

  test("multiple updates are merged cumulatively", () => {
    state.updatePlanning({ running: true, readyCount: 5 });
    state.updatePlanning({ lastResult: "completed", running: false });
    const status = state.getPlanningStatus();
    expect(status.running).toBe(false);
    expect(status.readyCount).toBe(5);
    expect(status.lastResult).toBe("completed");
  });
});

describe("AppState — togglePause", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("initially not paused", () => {
    expect(state.isPaused()).toBe(false);
  });

  test("togglePause flips paused to true", () => {
    const result = state.togglePause();
    expect(result).toBe(true);
    expect(state.isPaused()).toBe(true);
  });

  test("double toggle restores to false", () => {
    state.togglePause();
    const result = state.togglePause();
    expect(result).toBe(false);
    expect(state.isPaused()).toBe(false);
  });
});

describe("AppState — issue failure counter", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("getIssueFailureCount returns 0 for unknown issue", () => {
    expect(state.getIssueFailureCount("unknown-id")).toBe(0);
  });

  test("incrementIssueFailures returns 1 on first call", () => {
    expect(state.incrementIssueFailures("issue-1")).toBe(1);
  });

  test("incrementIssueFailures returns incrementing counts", () => {
    expect(state.incrementIssueFailures("issue-1")).toBe(1);
    expect(state.incrementIssueFailures("issue-1")).toBe(2);
    expect(state.incrementIssueFailures("issue-1")).toBe(3);
  });

  test("getIssueFailureCount reflects incremented value", () => {
    state.incrementIssueFailures("issue-1");
    state.incrementIssueFailures("issue-1");
    expect(state.getIssueFailureCount("issue-1")).toBe(2);
  });

  test("counters are independent per issue ID", () => {
    state.incrementIssueFailures("issue-1");
    state.incrementIssueFailures("issue-1");
    state.incrementIssueFailures("issue-2");
    expect(state.getIssueFailureCount("issue-1")).toBe(2);
    expect(state.getIssueFailureCount("issue-2")).toBe(1);
    expect(state.getIssueFailureCount("issue-3")).toBe(0);
  });
});

describe("AppState — clearIssueFailures", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("clearIssueFailures removes entry and returns 0 afterward", () => {
    state.incrementIssueFailures("issue-1");
    state.incrementIssueFailures("issue-1");
    state.clearIssueFailures("issue-1");
    expect(state.getIssueFailureCount("issue-1")).toBe(0);
  });

  test("clearIssueFailures is a no-op for unknown issue ID", () => {
    expect(() => state.clearIssueFailures("unknown-id")).not.toThrow();
    expect(state.getIssueFailureCount("unknown-id")).toBe(0);
  });

  test("clearIssueFailures does not affect other issue counters", () => {
    state.incrementIssueFailures("issue-1");
    state.incrementIssueFailures("issue-2");
    state.clearIssueFailures("issue-1");
    expect(state.getIssueFailureCount("issue-1")).toBe(0);
    expect(state.getIssueFailureCount("issue-2")).toBe(1);
  });
});

describe("AppState — issueFailureCount eviction cap", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("Map size does not exceed 1000 after 1010 insertions", () => {
    for (let i = 0; i < 1010; i++) {
      state.incrementIssueFailures(`issue-${i}`);
    }
    // Access the size via the public interface — insert one more and verify count is still 0 for evicted
    // We verify indirectly: the most recently inserted entries should be retained
    expect(state.getIssueFailureCount("issue-1009")).toBe(1);
    expect(state.getIssueFailureCount("issue-1008")).toBe(1);
  });

  test("oldest entries are evicted when cap is exceeded", () => {
    for (let i = 0; i < 1010; i++) {
      state.incrementIssueFailures(`issue-${i}`);
    }
    // The first 10 entries (issue-0 through issue-9) should have been evicted
    for (let i = 0; i < 10; i++) {
      expect(state.getIssueFailureCount(`issue-${i}`)).toBe(0);
    }
    // Entries beyond that should still be present
    expect(state.getIssueFailureCount("issue-10")).toBe(1);
  });
});

describe("AppState — getMaxParallel", () => {
  test("returns DEFAULTS.executor.parallel when constructed with no argument", () => {
    const state = new AppState();
    expect(state.getMaxParallel()).toBe(DEFAULTS.executor.parallel);
  });

  test("returns the value passed to the constructor", () => {
    const state = new AppState(7);
    expect(state.getMaxParallel()).toBe(7);
  });

  test("returns 1 when constructed with 1", () => {
    const state = new AppState(1);
    expect(state.getMaxParallel()).toBe(1);
  });
});

describe("AppState — toJSON", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("returns complete snapshot with all expected fields", () => {
    const snap = state.toJSON();
    expect(snap).toHaveProperty("paused", false);
    expect(snap).toHaveProperty("agents");
    expect(snap).toHaveProperty("history");
    expect(snap).toHaveProperty("queue");
    expect(snap).toHaveProperty("planning");
    expect(snap).toHaveProperty("startedAt");
    expect(Array.isArray(snap.agents)).toBe(true);
    expect(Array.isArray(snap.history)).toBe(true);
  });

  test("snapshot reflects current agent state", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    const snap = state.toJSON();
    expect(snap.agents.length).toBe(1);
    expect(snap.agents[0].issueId).toBe("ISSUE-1");
  });

  test("snapshot reflects paused state", () => {
    state.togglePause();
    expect(state.toJSON().paused).toBe(true);
  });
});

describe("AppState — spend tracking", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  // Helper: create a budget config with specific limits
  function makeBudgetConfig(
    overrides: Partial<(typeof DEFAULTS)["budget"]> = {},
  ) {
    return { ...DEFAULTS, budget: { ...DEFAULTS.budget, ...overrides } };
  }

  test("addSpend accumulates spend across multiple calls", () => {
    state.addSpend(1.5);
    state.addSpend(2.0);
    state.addSpend(0.5);
    expect(state.getDailySpend()).toBeCloseTo(4.0);
  });

  test("getDailySpend returns sum of entries within the last 24h", () => {
    state.addSpend(3.0);
    state.addSpend(1.0);
    expect(state.getDailySpend()).toBeCloseTo(4.0);
  });

  test("getDailySpend excludes entries older than 24h", () => {
    // Inject an old entry directly into the private spendLog
    (state as any).spendLog.push({
      timestampMs: Date.now() - 25 * 60 * 60 * 1000,
      costUsd: 100,
    });
    state.addSpend(5.0);
    expect(state.getDailySpend()).toBeCloseTo(5.0);
  });

  test("getMonthlySpend returns sum of entries in current UTC calendar month", () => {
    state.addSpend(10.0);
    state.addSpend(5.0);
    expect(state.getMonthlySpend()).toBeCloseTo(15.0);
  });

  test("getMonthlySpend excludes entries from a previous month", () => {
    // Inject an entry from ~35 days ago (safely in a previous calendar month)
    (state as any).spendLog.push({
      timestampMs: Date.now() - 35 * 24 * 60 * 60 * 1000,
      costUsd: 200,
    });
    state.addSpend(7.0);
    expect(state.getMonthlySpend()).toBeCloseTo(7.0);
  });

  test("checkBudget returns ok:true when all limits are 0 (disabled)", () => {
    state.addSpend(999);
    const result = state.checkBudget(makeBudgetConfig());
    expect(result).toEqual({ ok: true });
  });

  test("checkBudget returns ok:false when daily limit is met", () => {
    state.addSpend(5.0);
    const result = state.checkBudget(makeBudgetConfig({ daily_limit_usd: 5 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Daily budget");
  });

  test("checkBudget returns ok:false when daily limit is exceeded", () => {
    state.addSpend(10.0);
    const result = state.checkBudget(makeBudgetConfig({ daily_limit_usd: 5 }));
    expect(result.ok).toBe(false);
  });

  test("checkBudget returns ok:true when spend is below daily limit", () => {
    state.addSpend(3.0);
    const result = state.checkBudget(makeBudgetConfig({ daily_limit_usd: 10 }));
    expect(result.ok).toBe(true);
  });

  test("checkBudget returns ok:false when monthly limit is met", () => {
    state.addSpend(50.0);
    const result = state.checkBudget(
      makeBudgetConfig({ monthly_limit_usd: 50 }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Monthly budget");
  });

  test("checkBudget returns ok:false when monthly limit is exceeded", () => {
    state.addSpend(100.0);
    const result = state.checkBudget(
      makeBudgetConfig({ monthly_limit_usd: 50 }),
    );
    expect(result.ok).toBe(false);
  });

  test("checkBudget returns ok:true when spend is below monthly limit", () => {
    state.addSpend(20.0);
    const result = state.checkBudget(
      makeBudgetConfig({ monthly_limit_usd: 100 }),
    );
    expect(result.ok).toBe(true);
  });

  test("completeAgent calls addSpend when costUsd > 0", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed", { costUsd: 2.5 });
    expect(state.getDailySpend()).toBeCloseTo(2.5);
  });

  test("completeAgent does not call addSpend when costUsd is 0", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed", { costUsd: 0 });
    expect(state.getDailySpend()).toBe(0);
  });

  test("completeAgent does not call addSpend when costUsd is undefined", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed", {});
    expect(state.getDailySpend()).toBe(0);
  });

  test("addSpend evicts entries older than 32 days", () => {
    // Inject a very old entry
    (state as any).spendLog.push({
      timestampMs: Date.now() - 33 * 24 * 60 * 60 * 1000,
      costUsd: 500,
    });
    // Adding a new entry triggers eviction
    state.addSpend(1.0);
    // The old entry should be gone — monthly and daily should only see the new entry
    expect(state.getDailySpend()).toBeCloseTo(1.0);
    expect((state as any).spendLog).toHaveLength(1);
  });
});
