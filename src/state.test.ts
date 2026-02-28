import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "./lib/config";
import {
  getConversationLog,
  getRecentPlanningSessions,
  openDb,
} from "./lib/db";
import type { ActivityEntry, PlanningSession } from "./state";
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

  test("completeAgent with sessionId populates it in the result", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed", { sessionId: "sess-abc-123" });
    const result = state.getHistory()[0];
    expect(result.sessionId).toBe("sess-abc-123");
  });

  test("completeAgent without sessionId leaves it undefined in result", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    state.completeAgent("a1", "completed");
    const result = state.getHistory()[0];
    expect(result.sessionId).toBeUndefined();
  });

  test("completeAgent with rawMessages does not crash", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    expect(() =>
      state.completeAgent("a1", "completed", {}, [
        { type: "text" },
        { type: "result" },
      ]),
    ).not.toThrow();
  });

  test("completeAgent without rawMessages does not crash", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    expect(() => state.completeAgent("a1", "completed")).not.toThrow();
  });

  test("completeAgent with empty rawMessages does not crash", () => {
    state.addAgent("a1", "ISSUE-1", "Test");
    expect(() => state.completeAgent("a1", "completed", {}, [])).not.toThrow();
  });

  test("completeAgent with rawMessages and DB persists conversation log", async () => {
    const db = openDb(":memory:");
    state.setDb(db);
    state.addAgent("a1", "ISSUE-1", "Test");
    const messages = [{ type: "text", content: "hello" }];
    await state.completeAgent("a1", "completed", {}, messages);
    const agentId = state.getHistory()[0].id;
    const log = getConversationLog(db, agentId);
    expect(log).not.toBeNull();
    expect(JSON.parse(log as string)).toEqual(messages);
    db.close();
  });

  test("completeAgent with empty rawMessages does not persist conversation log", async () => {
    const db = openDb(":memory:");
    state.setDb(db);
    state.addAgent("a1", "ISSUE-1", "Test");
    await state.completeAgent("a1", "completed", {}, []);
    const agentId = state.getHistory()[0].id;
    expect(getConversationLog(db, agentId)).toBeNull();
    db.close();
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

describe("AppState — planningHistory", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("getPlanningHistory returns empty array initially", () => {
    expect(state.getPlanningHistory()).toEqual([]);
  });

  test("addPlanningSession adds session to history", () => {
    const session = {
      id: "ps-1",
      agentRunId: "run-1",
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed" as const,
      issuesFiledCount: 3,
    };
    state.addPlanningSession(session);
    expect(state.getPlanningHistory()).toHaveLength(1);
    expect(state.getPlanningHistory()[0]).toEqual(session);
  });

  test("addPlanningSession prepends (newest first)", () => {
    state.addPlanningSession({
      id: "ps-1",
      agentRunId: "run-1",
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed",
      issuesFiledCount: 1,
    });
    state.addPlanningSession({
      id: "ps-2",
      agentRunId: "run-2",
      startedAt: 3000,
      finishedAt: 4000,
      status: "failed",
      issuesFiledCount: 0,
    });
    const history = state.getPlanningHistory();
    expect(history[0].id).toBe("ps-2");
    expect(history[1].id).toBe("ps-1");
  });

  test("planningHistory is capped at 20 entries", () => {
    for (let i = 0; i < 25; i++) {
      state.addPlanningSession({
        id: `ps-${i}`,
        agentRunId: `run-${i}`,
        startedAt: i * 1000,
        finishedAt: i * 1000 + 500,
        status: "completed",
        issuesFiledCount: 0,
      });
    }
    expect(state.getPlanningHistory()).toHaveLength(20);
  });

  test("planningHistory cap keeps the most recent entries", () => {
    for (let i = 0; i < 25; i++) {
      state.addPlanningSession({
        id: `ps-${i}`,
        agentRunId: `run-${i}`,
        startedAt: i * 1000,
        finishedAt: i * 1000 + 500,
        status: "completed",
        issuesFiledCount: 0,
      });
    }
    const history = state.getPlanningHistory();
    // Newest entry (ps-24) should be first
    expect(history[0].id).toBe("ps-24");
    // Oldest kept entry should be ps-5 (24 - 20 + 1 = 5)
    expect(history[19].id).toBe("ps-5");
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
    expect(snap).toHaveProperty("planningHistory");
    expect(snap).toHaveProperty("startedAt");
    expect(Array.isArray(snap.agents)).toBe(true);
    expect(Array.isArray(snap.history)).toBe(true);
    expect(Array.isArray(snap.planningHistory)).toBe(true);
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

describe("AppState — planningHistory persistence", () => {
  function makeSession(
    id: string,
    overrides?: Partial<PlanningSession>,
  ): PlanningSession {
    return {
      id,
      agentRunId: `run-${id}`,
      startedAt: 1000,
      finishedAt: 2000,
      status: "completed",
      issuesFiledCount: 0,
      ...overrides,
    };
  }

  test("addPlanningSession persists to DB when DB is set", async () => {
    const state = new AppState();
    const db = openDb(":memory:");
    state.setDb(db);

    const session = makeSession("ps-1");
    state.addPlanningSession(session);

    // Allow async DB write to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const persisted = getRecentPlanningSessions(db);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe("ps-1");

    db.close();
  });

  test("addPlanningSession does not throw when DB is not set", () => {
    const state = new AppState();
    expect(() => state.addPlanningSession(makeSession("ps-1"))).not.toThrow();
  });

  test("setDb loads persisted planning sessions from DB", async () => {
    const db = openDb(":memory:");
    const state1 = new AppState();
    state1.setDb(db);

    // Add two sessions to the first state instance (persists to DB)
    state1.addPlanningSession(
      makeSession("ps-1", { startedAt: 1000, finishedAt: 2000 }),
    );
    state1.addPlanningSession(
      makeSession("ps-2", { startedAt: 3000, finishedAt: 4000 }),
    );

    // Allow async DB writes to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Create a second state instance wired to the same DB
    const state2 = new AppState();
    state2.setDb(db);

    const history = state2.getPlanningHistory();
    expect(history).toHaveLength(2);
    // Newest-first (by finished_at)
    expect(history[0].id).toBe("ps-2");
    expect(history[1].id).toBe("ps-1");

    db.close();
  });

  test("addPlanningSession persists all fields including JSON columns", async () => {
    const state = new AppState();
    const db = openDb(":memory:");
    state.setDb(db);

    const session = makeSession("ps-full", {
      summary: "Planning done",
      issuesFiledCount: 2,
      issuesFiled: [
        { identifier: "ENG-10", title: "First issue" },
        { identifier: "ENG-11", title: "Second issue" },
      ],
      findingsRejected: [{ finding: "Add logging", reason: "Out of scope" }],
      costUsd: 0.42,
    });
    state.addPlanningSession(session);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const persisted = getRecentPlanningSessions(db)[0];
    expect(persisted.summary).toBe("Planning done");
    expect(persisted.issuesFiledCount).toBe(2);
    expect(persisted.issuesFiled).toEqual(session.issuesFiled);
    expect(persisted.findingsRejected).toEqual(session.findingsRejected);
    expect(persisted.costUsd).toBe(0.42);

    db.close();
  });
});

describe("AppState — spendLog reconstruction from DB", () => {
  function insertRun(
    db: ReturnType<typeof openDb>,
    id: string,
    finishedAt: number,
    costUsd: number | null,
  ) {
    db.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, "ISSUE-1", "Test", "completed", finishedAt, finishedAt, costUsd],
    );
  }

  test("setDb reconstructs getDailySpend from agent_runs within last 24h", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    insertRun(db, "run-1", now - 3_600_000, 2.5); // 1h ago — within daily window
    insertRun(db, "run-2", now - 25 * 3_600_000, 10.0); // 25h ago — outside daily window

    const state = new AppState();
    state.setDb(db);

    expect(state.getDailySpend()).toBeCloseTo(2.5);
    db.close();
  });

  test("setDb reconstructs getMonthlySpend from agent_runs within current UTC calendar month", () => {
    const db = openDb(":memory:");
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const withinMonthMs = monthStart + 3_600_000; // 1h after month start
    const prevMonthMs = monthStart - 24 * 3_600_000; // 1 day before month start

    insertRun(db, "run-1", withinMonthMs, 5.0);
    insertRun(db, "run-2", prevMonthMs, 20.0);

    const state = new AppState();
    state.setDb(db);

    expect(state.getMonthlySpend()).toBeCloseTo(5.0);
    db.close();
  });

  test("setDb ignores agent_runs with NULL cost_usd", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    insertRun(db, "run-1", now - 3_600_000, null);
    insertRun(db, "run-2", now - 3_600_000, 1.5);

    const state = new AppState();
    state.setDb(db);

    expect(state.getDailySpend()).toBeCloseTo(1.5);
    db.close();
  });

  test("setDb ignores agent_runs with cost_usd = 0", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    insertRun(db, "run-1", now - 3_600_000, 0);
    insertRun(db, "run-2", now - 3_600_000, 3.0);

    const state = new AppState();
    state.setDb(db);

    expect(state.getDailySpend()).toBeCloseTo(3.0);
    db.close();
  });

  test("setDb does not load agent_runs older than 32 days", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const oldMs = now - 33 * 24 * 3_600_000;

    insertRun(db, "run-1", oldMs, 100.0);
    insertRun(db, "run-2", now - 3_600_000, 2.0);

    const state = new AppState();
    state.setDb(db);

    expect(state.getDailySpend()).toBeCloseTo(2.0);
    expect((state as any).spendLog).toHaveLength(1);
    db.close();
  });
});
