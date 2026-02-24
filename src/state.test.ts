import { beforeEach, describe, expect, test } from "bun:test";
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

describe("AppState — updateAuditor", () => {
  let state: AppState;

  beforeEach(() => {
    state = new AppState();
  });

  test("initially auditor is not running", () => {
    expect(state.getAuditorStatus().running).toBe(false);
  });

  test("partial update merges into auditor status", () => {
    state.updateAuditor({ running: true });
    expect(state.getAuditorStatus().running).toBe(true);
  });

  test("multiple updates are merged cumulatively", () => {
    state.updateAuditor({ running: true, readyCount: 5 });
    state.updateAuditor({ lastResult: "completed", running: false });
    const status = state.getAuditorStatus();
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
    expect(snap).toHaveProperty("auditor");
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
