import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityEntry, AgentResult, PlanningSession } from "../state";
import {
  deleteOAuthToken,
  getActivityLogs,
  getAnalytics,
  getConversationLog,
  getCostByStatus,
  getDailyCostTrend,
  getFailuresByType,
  getFailureTrend,
  getOAuthToken,
  getRecentPlanningSessions,
  getRecentRuns,
  getRepeatFailures,
  getRunWithTranscript,
  getUnreviewedRuns,
  getWeeklyCostTrend,
  insertActivityLogs,
  insertAgentRun,
  insertConversationLog,
  insertPlanningSession,
  isSqliteBusy,
  markRunsReviewed,
  openDb,
  pruneActivityLogs,
  pruneConversationLogs,
  saveOAuthToken,
} from "./db";
import { sanitizeMessage } from "./sanitize";

let db: Database;

function makeResult(id: string, overrides?: Partial<AgentResult>): AgentResult {
  return {
    id,
    issueId: `ISSUE-${id}`,
    issueTitle: `Title ${id}`,
    status: "completed",
    startedAt: 1000,
    finishedAt: 2000,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("openDb", () => {
  test("creates schema and returns an open database", () => {
    // If openDb succeeded without throwing, schema was created
    expect(db).toBeDefined();
  });

  test("migration adds linear_issue_id column to existing DB without it", () => {
    // Simulate an old DB that lacks the linear_issue_id column
    const oldDb = new Database(":memory:", { create: true });
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_finished_at ON agent_runs(finished_at);
    `);
    // Insert a row before migration (no linear_issue_id column yet)
    oldDb.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );
    oldDb.close();

    // Re-open via openDb — it should run the migration without error
    // We can't re-open :memory: by path, so instead test the migration directly
    // by running it on a fresh in-memory DB that already has the schema without the column
    const db2 = new Database(":memory:", { create: true });
    db2.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_finished_at ON agent_runs(finished_at);
    `);
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );

    // Run the migration (same as openDb does)
    try {
      db2.exec("ALTER TABLE agent_runs ADD COLUMN linear_issue_id TEXT");
    } catch {
      // ignore duplicate column
    }

    // Pre-migration row should have null for the new column
    const row = db2
      .query<{ linear_issue_id: string | null }, [string]>(
        "SELECT linear_issue_id FROM agent_runs WHERE id = ?",
      )
      .get("pre-migration");
    expect(row?.linear_issue_id).toBeNull();

    // New rows inserted after migration can use the column
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at, linear_issue_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "post-migration",
        "ISSUE-2",
        "New Title",
        "completed",
        3000,
        4000,
        "uuid-xyz",
      ],
    );
    const newRow = db2
      .query<{ linear_issue_id: string | null }, [string]>(
        "SELECT linear_issue_id FROM agent_runs WHERE id = ?",
      )
      .get("post-migration");
    expect(newRow?.linear_issue_id).toBe("uuid-xyz");

    db2.close();
  });

  test("migration is idempotent on a new DB that already has the column", () => {
    // openDb on :memory: creates the schema with linear_issue_id, then tries ALTER TABLE
    // The ALTER TABLE should be silently ignored — no error thrown
    expect(() => openDb(":memory:")).not.toThrow();
  });
});

describe("isSqliteBusy", () => {
  test("returns true for SQLITE_BUSY (errno=5)", () => {
    const err = Object.assign(new Error("database is locked"), { errno: 5 });
    expect(isSqliteBusy(err)).toBe(true);
  });

  test("returns true for SQLITE_LOCKED (errno=6)", () => {
    const err = Object.assign(new Error("table is locked"), { errno: 6 });
    expect(isSqliteBusy(err)).toBe(true);
  });

  test("returns true for SQLITE_BUSY via code property (code=5)", () => {
    const err = Object.assign(new Error("database is locked"), { code: 5 });
    expect(isSqliteBusy(err)).toBe(true);
  });

  test("returns false for other SQLite error codes", () => {
    const err = Object.assign(new Error("no such table"), { errno: 1 });
    expect(isSqliteBusy(err)).toBe(false);
  });

  test("returns true when message contains 'database is locked'", () => {
    expect(isSqliteBusy(new Error("database is locked"))).toBe(true);
  });

  test("returns true when message contains 'sqlite_busy'", () => {
    expect(isSqliteBusy(new Error("SQLITE_BUSY: database is locked"))).toBe(
      true,
    );
  });

  test("returns false for non-Error values", () => {
    expect(isSqliteBusy("string error")).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isSqliteBusy(new Error("no such table: agent_runs"))).toBe(false);
    expect(isSqliteBusy(new Error("UNIQUE constraint failed"))).toBe(false);
  });
});

describe("insertAgentRun and getRecentRuns", () => {
  test("inserts and retrieves a run", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const runs = getRecentRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("a1");
    expect(runs[0].issueId).toBe("ISSUE-a1");
    expect(runs[0].issueTitle).toBe("Title a1");
    expect(runs[0].status).toBe("completed");
  });

  test("retrieves runs in newest-first order by finished_at", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { startedAt: 1000, finishedAt: 2000 }),
    );
    await insertAgentRun(
      db,
      makeResult("a2", { startedAt: 3000, finishedAt: 4000 }),
    );
    const runs = getRecentRuns(db);
    expect(runs[0].id).toBe("a2");
    expect(runs[1].id).toBe("a1");
  });

  test("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAgentRun(
        db,
        makeResult(`a${i}`, {
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
        }),
      );
    }
    const runs = getRecentRuns(db, 3);
    expect(runs).toHaveLength(3);
  });

  test("stores and retrieves optional fields", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { costUsd: 0.05, durationMs: 30000, numTurns: 10 }),
    );
    const run = getRecentRuns(db)[0];
    expect(run.costUsd).toBe(0.05);
    expect(run.durationMs).toBe(30000);
    expect(run.numTurns).toBe(10);
  });

  test("optional fields are undefined when not set", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.costUsd).toBeUndefined();
    expect(run.durationMs).toBeUndefined();
    expect(run.numTurns).toBeUndefined();
    expect(run.error).toBeUndefined();
  });

  test("stores error field when set", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { status: "failed", error: "timeout" }),
    );
    const run = getRecentRuns(db)[0];
    expect(run.status).toBe("failed");
    expect(run.error).toBe("timeout");
  });

  test("stores and retrieves linearIssueId when set", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { linearIssueId: "uuid-1234-abcd" }),
    );
    const run = getRecentRuns(db)[0];
    expect(run.linearIssueId).toBe("uuid-1234-abcd");
  });

  test("linearIssueId is undefined when not set", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.linearIssueId).toBeUndefined();
  });

  test("OR REPLACE upserts a run with the same id", async () => {
    await insertAgentRun(db, makeResult("a1", { status: "completed" }));
    await insertAgentRun(db, makeResult("a1", { status: "failed" }));
    const runs = getRecentRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });

  test("returns empty array when no runs exist", () => {
    expect(getRecentRuns(db)).toEqual([]);
  });

  test("default limit is 50", async () => {
    for (let i = 0; i < 60; i++) {
      await insertAgentRun(
        db,
        makeResult(`a${i}`, {
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
        }),
      );
    }
    const runs = getRecentRuns(db);
    expect(runs).toHaveLength(50);
  });
});

describe("getAnalytics", () => {
  test("returns zeros for empty database", () => {
    const result = getAnalytics(db);
    expect(result.totalRuns).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.avgDurationMs).toBe(0);
  });

  test("calculates success rate correctly", async () => {
    await insertAgentRun(db, makeResult("a1", { status: "completed" }));
    await insertAgentRun(db, makeResult("a2", { status: "completed" }));
    await insertAgentRun(db, makeResult("a3", { status: "failed" }));
    await insertAgentRun(db, makeResult("a4", { status: "timed_out" }));
    const result = getAnalytics(db);
    expect(result.totalRuns).toBe(4);
    expect(result.successRate).toBe(0.5);
  });

  test("success rate is 1.0 when all runs succeed", async () => {
    await insertAgentRun(db, makeResult("a1", { status: "completed" }));
    await insertAgentRun(db, makeResult("a2", { status: "completed" }));
    const result = getAnalytics(db);
    expect(result.successRate).toBe(1.0);
  });

  test("success rate is 0 when all runs fail", async () => {
    await insertAgentRun(db, makeResult("a1", { status: "failed" }));
    const result = getAnalytics(db);
    expect(result.successRate).toBe(0);
  });

  test("sums total cost correctly", async () => {
    await insertAgentRun(db, makeResult("a1", { costUsd: 0.1 }));
    await insertAgentRun(db, makeResult("a2", { costUsd: 0.2 }));
    const result = getAnalytics(db);
    expect(result.totalCostUsd).toBeCloseTo(0.3);
  });

  test("total cost is 0 when no cost data", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const result = getAnalytics(db);
    expect(result.totalCostUsd).toBe(0);
  });

  test("averages duration correctly", async () => {
    await insertAgentRun(db, makeResult("a1", { durationMs: 1000 }));
    await insertAgentRun(db, makeResult("a2", { durationMs: 3000 }));
    const result = getAnalytics(db);
    expect(result.avgDurationMs).toBe(2000);
  });

  test("avg duration is 0 when no duration data", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const result = getAnalytics(db);
    expect(result.avgDurationMs).toBe(0);
  });

  test("counts total runs correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAgentRun(db, makeResult(`a${i}`));
    }
    const result = getAnalytics(db);
    expect(result.totalRuns).toBe(5);
  });
});

describe("insertActivityLogs and getActivityLogs", () => {
  function makeActivity(overrides?: Partial<ActivityEntry>): ActivityEntry {
    return {
      timestamp: Date.now(),
      type: "tool_use",
      summary: "Test: doing something",
      ...overrides,
    };
  }

  test("insertActivityLogs with empty array is a no-op", async () => {
    await expect(insertActivityLogs(db, "run-1", [])).resolves.toBeUndefined();
    expect(getActivityLogs(db, "run-1")).toEqual([]);
  });

  test("inserts and retrieves activity logs in timestamp order", async () => {
    const activities: ActivityEntry[] = [
      makeActivity({ timestamp: 3000, type: "text", summary: "Third" }),
      makeActivity({ timestamp: 1000, type: "tool_use", summary: "First" }),
      makeActivity({ timestamp: 2000, type: "result", summary: "Second" }),
    ];
    await insertActivityLogs(db, "run-1", activities);
    const logs = getActivityLogs(db, "run-1");
    expect(logs).toHaveLength(3);
    expect(logs[0].summary).toBe("First");
    expect(logs[1].summary).toBe("Second");
    expect(logs[2].summary).toBe("Third");
  });

  test("retrieves all five entries inserted", async () => {
    const activities: ActivityEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeActivity({ timestamp: i * 1000, summary: `Entry ${i}` }),
    );
    await insertActivityLogs(db, "run-1", activities);
    const logs = getActivityLogs(db, "run-1");
    expect(logs).toHaveLength(5);
  });

  test("returns empty array for unknown agentRunId", () => {
    expect(getActivityLogs(db, "nonexistent")).toEqual([]);
  });

  test("stores and retrieves detail field", async () => {
    const activity = makeActivity({ detail: "some detail text" });
    await insertActivityLogs(db, "run-1", [activity]);
    const logs = getActivityLogs(db, "run-1");
    expect(logs[0].detail).toBe("some detail text");
  });

  test("detail is undefined when not set", async () => {
    const activity = makeActivity();
    await insertActivityLogs(db, "run-1", [activity]);
    const logs = getActivityLogs(db, "run-1");
    expect(logs[0].detail).toBeUndefined();
  });

  test("isolates logs by agentRunId", async () => {
    await insertActivityLogs(db, "run-1", [
      makeActivity({ summary: "Run 1 entry" }),
    ]);
    await insertActivityLogs(db, "run-2", [
      makeActivity({ summary: "Run 2 entry" }),
    ]);
    expect(getActivityLogs(db, "run-1")).toHaveLength(1);
    expect(getActivityLogs(db, "run-1")[0].summary).toBe("Run 1 entry");
    expect(getActivityLogs(db, "run-2")).toHaveLength(1);
  });
});

describe("pruneActivityLogs", () => {
  test("deletes entries older than retention window", async () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    await insertActivityLogs(db, "run-old", [
      { timestamp: thirtyOneDaysAgo, type: "text", summary: "Old entry" },
    ]);
    await insertActivityLogs(db, "run-new", [
      { timestamp: now, type: "text", summary: "New entry" },
    ]);
    const deleted = pruneActivityLogs(db, 30);
    expect(deleted).toBe(1);
    expect(getActivityLogs(db, "run-old")).toHaveLength(0);
    expect(getActivityLogs(db, "run-new")).toHaveLength(1);
  });

  test("returns 0 when no entries are old enough to prune", async () => {
    const now = Date.now();
    await insertActivityLogs(db, "run-1", [
      { timestamp: now, type: "text", summary: "Recent entry" },
    ]);
    const deleted = pruneActivityLogs(db, 30);
    expect(deleted).toBe(0);
  });

  test("returns 0 on empty table", () => {
    expect(pruneActivityLogs(db, 30)).toBe(0);
  });

  test("preserves entries within the retention window", async () => {
    const now = Date.now();
    const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;
    await insertActivityLogs(db, "run-1", [
      { timestamp: twentyNineDaysAgo, type: "text", summary: "Within window" },
    ]);
    const deleted = pruneActivityLogs(db, 30);
    expect(deleted).toBe(0);
    expect(getActivityLogs(db, "run-1")).toHaveLength(1);
  });
});

describe("session_id migration", () => {
  test("migration adds session_id column to existing DB without it", () => {
    const db2 = new Database(":memory:", { create: true });
    db2.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
    `);
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );

    // Run the migration
    try {
      db2.exec("ALTER TABLE agent_runs ADD COLUMN session_id TEXT");
    } catch {
      // ignore duplicate column
    }

    // Pre-migration row should have null for the new column
    const row = db2
      .query<{ session_id: string | null }, [string]>(
        "SELECT session_id FROM agent_runs WHERE id = ?",
      )
      .get("pre-migration");
    expect(row?.session_id).toBeNull();

    db2.close();
  });

  test("session_id migration is idempotent on a new DB", () => {
    // openDb on :memory: already creates schema with the migration applied
    // Running it again should not throw
    expect(() => openDb(":memory:")).not.toThrow();
  });
});

describe("insertAgentRun with sessionId", () => {
  test("stores and retrieves sessionId", async () => {
    await insertAgentRun(db, makeResult("a1", { sessionId: "sess-abc-123" }));
    const run = getRecentRuns(db)[0];
    expect(run.sessionId).toBe("sess-abc-123");
  });

  test("sessionId is undefined when not set", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.sessionId).toBeUndefined();
  });

  test("getRecentRuns does not include messagesJson field", async () => {
    await insertAgentRun(db, makeResult("a1", { sessionId: "sess-xyz" }));
    const run = getRecentRuns(db)[0];
    expect(
      (run as unknown as Record<string, unknown>).messagesJson,
    ).toBeUndefined();
  });
});

describe("insertConversationLog and getConversationLog", () => {
  test("round-trip stores and retrieves messages JSON", async () => {
    await insertAgentRun(db, makeResult("run-1"));
    const messages = [
      { type: "text", content: "hello" },
      { type: "result", content: "done" },
    ];
    await insertConversationLog(db, "run-1", JSON.stringify(messages));
    const retrieved = getConversationLog(db, "run-1");
    expect(retrieved).not.toBeNull();
    expect(JSON.parse(retrieved as string)).toEqual(messages);
  });

  test("getConversationLog returns null for unknown run ID", () => {
    expect(getConversationLog(db, "nonexistent-run")).toBeNull();
  });

  test("INSERT OR REPLACE overwrites existing log for same run ID", async () => {
    await insertAgentRun(db, makeResult("run-1"));
    await insertConversationLog(db, "run-1", JSON.stringify(["first"]));
    await insertConversationLog(db, "run-1", JSON.stringify(["second"]));
    const retrieved = getConversationLog(db, "run-1");
    expect(retrieved).not.toBeNull();
    expect(JSON.parse(retrieved as string)).toEqual(["second"]);
  });
});

describe("pruneConversationLogs", () => {
  test("deletes entries older than retention window", async () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    await insertAgentRun(db, makeResult("run-old"));
    await insertAgentRun(db, makeResult("run-new"));
    // Manually insert an old entry
    db.run(
      `INSERT OR REPLACE INTO conversation_log (agent_run_id, messages_json, created_at) VALUES (?, ?, ?)`,
      ["run-old", "[]", thirtyOneDaysAgo],
    );
    db.run(
      `INSERT OR REPLACE INTO conversation_log (agent_run_id, messages_json, created_at) VALUES (?, ?, ?)`,
      ["run-new", "[]", now],
    );
    const deleted = pruneConversationLogs(db, 30);
    expect(deleted).toBe(1);
    expect(getConversationLog(db, "run-old")).toBeNull();
    expect(getConversationLog(db, "run-new")).not.toBeNull();
  });

  test("returns 0 when no entries are old enough to prune", async () => {
    await insertAgentRun(db, makeResult("run-1"));
    await insertConversationLog(db, "run-1", "[]");
    expect(pruneConversationLogs(db, 30)).toBe(0);
  });

  test("returns 0 on empty table", () => {
    expect(pruneConversationLogs(db, 30)).toBe(0);
  });
});

describe("reviewed_at migration", () => {
  test("migration adds reviewed_at column to existing DB without it", () => {
    const db2 = new Database(":memory:", { create: true });
    db2.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
    `);
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );

    // Run the migration
    try {
      db2.exec("ALTER TABLE agent_runs ADD COLUMN reviewed_at INTEGER");
    } catch {
      // ignore duplicate column
    }

    const row = db2
      .query<{ reviewed_at: number | null }, [string]>(
        "SELECT reviewed_at FROM agent_runs WHERE id = ?",
      )
      .get("pre-migration");
    expect(row?.reviewed_at).toBeNull();

    db2.close();
  });

  test("reviewed_at migration is idempotent on a new DB", () => {
    expect(() => openDb(":memory:")).not.toThrow();
  });
});

describe("getUnreviewedRuns", () => {
  test("returns only runs where reviewed_at IS NULL", async () => {
    await insertAgentRun(db, makeResult("r1", { status: "completed" }));
    await insertAgentRun(db, makeResult("r2", { status: "failed" }));
    await insertAgentRun(db, makeResult("r3", { status: "timed_out" }));
    await markRunsReviewed(db, ["r1"]);

    const runs = getUnreviewedRuns(db);
    expect(runs).toHaveLength(2);
    const ids = runs.map((r) => r.id);
    expect(ids).not.toContain("r1");
    expect(ids).toContain("r2");
    expect(ids).toContain("r3");
  });

  test("returns runs in ascending finished_at order", async () => {
    await insertAgentRun(
      db,
      makeResult("r1", { startedAt: 3000, finishedAt: 4000 }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { startedAt: 1000, finishedAt: 2000 }),
    );

    const runs = getUnreviewedRuns(db);
    expect(runs[0].id).toBe("r2");
    expect(runs[1].id).toBe("r1");
  });

  test("respects the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await insertAgentRun(
        db,
        makeResult(`r${i}`, {
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
        }),
      );
    }
    const runs = getUnreviewedRuns(db, 5);
    expect(runs).toHaveLength(5);
  });

  test("returns empty array when all runs are reviewed", async () => {
    await insertAgentRun(db, makeResult("r1"));
    await markRunsReviewed(db, ["r1"]);
    expect(getUnreviewedRuns(db)).toHaveLength(0);
  });

  test("returns empty array when no runs exist", () => {
    expect(getUnreviewedRuns(db)).toHaveLength(0);
  });
});

describe("getRunWithTranscript", () => {
  test("returns run metadata and null messagesJson when no conversation log", async () => {
    await insertAgentRun(db, makeResult("r1", { status: "completed" }));
    const result = getRunWithTranscript(db, "r1");
    expect(result.run.id).toBe("r1");
    expect(result.run.status).toBe("completed");
    expect(result.messagesJson).toBeNull();
  });

  test("returns run metadata and messagesJson when conversation log exists", async () => {
    await insertAgentRun(db, makeResult("r1"));
    const messages = [{ type: "text", content: "hello" }];
    await insertConversationLog(db, "r1", JSON.stringify(messages));

    const result = getRunWithTranscript(db, "r1");
    expect(result.run.id).toBe("r1");
    expect(result.messagesJson).not.toBeNull();
    expect(JSON.parse(result.messagesJson as string)).toEqual(messages);
  });

  test("throws an error for unknown run ID", () => {
    expect(() => getRunWithTranscript(db, "nonexistent")).toThrow(
      "Agent run not found",
    );
  });
});

describe("markRunsReviewed", () => {
  test("sets reviewed_at for the specified run IDs", async () => {
    await insertAgentRun(db, makeResult("r1"));
    await insertAgentRun(db, makeResult("r2"));

    await markRunsReviewed(db, ["r1"]);

    const unreviewedAfter = getUnreviewedRuns(db);
    expect(unreviewedAfter).toHaveLength(1);
    expect(unreviewedAfter[0].id).toBe("r2");
  });

  test("is a no-op for empty array", async () => {
    await insertAgentRun(db, makeResult("r1"));
    await expect(markRunsReviewed(db, [])).resolves.toBeUndefined();
    expect(getUnreviewedRuns(db)).toHaveLength(1);
  });

  test("batch-updates multiple run IDs", async () => {
    await insertAgentRun(db, makeResult("r1"));
    await insertAgentRun(db, makeResult("r2"));
    await insertAgentRun(db, makeResult("r3"));

    await markRunsReviewed(db, ["r1", "r2"]);

    const unreviewed = getUnreviewedRuns(db);
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0].id).toBe("r3");
  });

  test("reviewedAt is set on results returned from getRecentRuns after marking", async () => {
    await insertAgentRun(db, makeResult("r1"));
    await markRunsReviewed(db, ["r1"]);

    const runs = getRecentRuns(db);
    expect(runs[0].reviewedAt).toBeDefined();
    expect(typeof runs[0].reviewedAt).toBe("number");
  });
});

describe("concurrent writes do not lose data", () => {
  test("N simultaneous insertAgentRun calls all persist data", async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        insertAgentRun(
          db,
          makeResult(`concurrent-${i}`, {
            startedAt: i * 1000,
            finishedAt: i * 1000 + 500,
          }),
        ),
      ),
    );
    const runs = getRecentRuns(db, N);
    expect(runs).toHaveLength(N);
  });

  test("N simultaneous insertActivityLogs calls all persist data", async () => {
    const N = 10;
    // Insert agent runs first
    for (let i = 0; i < N; i++) {
      await insertAgentRun(db, makeResult(`run-${i}`));
    }
    // Insert activity logs concurrently
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        insertActivityLogs(db, `run-${i}`, [
          {
            timestamp: Date.now(),
            type: "tool_use",
            summary: `Activity for run ${i}`,
          },
        ]),
      ),
    );
    // Verify all activity logs were stored
    let total = 0;
    for (let i = 0; i < N; i++) {
      total += getActivityLogs(db, `run-${i}`).length;
    }
    expect(total).toBe(N);
  });
});

describe("transcript redaction before storage", () => {
  test("sanitized transcript has secrets redacted and stored value is valid JSON", () => {
    insertAgentRun(db, makeResult("run-secrets"));
    const rawMessages = [
      {
        role: "tool_result",
        content:
          "cat .env returned: AWS_KEY=AKIAIOSFODNN7EXAMPLE password=supersecret123",
      },
      {
        role: "assistant",
        content: "I can see credentials in the output",
      },
    ];
    const scrubbedJson = sanitizeMessage(JSON.stringify(rawMessages));
    insertConversationLog(db, "run-secrets", scrubbedJson);

    const retrieved = getConversationLog(db, "run-secrets");
    expect(retrieved).not.toBeNull();
    expect(retrieved).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(retrieved).not.toContain("supersecret123");
    expect(() => JSON.parse(retrieved as string)).not.toThrow();
  });

  test("round-trip: JSON.parse succeeds on scrubbed transcript with secrets in JSON string values", () => {
    insertAgentRun(db, makeResult("run-roundtrip"));
    const rawMessages = [
      {
        type: "text",
        content:
          "Found sk_live_abcdefghijklmnopqrst in config and npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij in package",
      },
    ];
    const scrubbedJson = sanitizeMessage(JSON.stringify(rawMessages));
    insertConversationLog(db, "run-roundtrip", scrubbedJson);

    const retrieved = getConversationLog(db, "run-roundtrip");
    expect(retrieved).not.toBeNull();
    const parsed = JSON.parse(retrieved as string) as typeof rawMessages;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].content).toContain("[REDACTED]");
    expect(parsed[0].content).not.toContain("abcdefghijklmnopqrst");
    expect(parsed[0].content).not.toContain(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
  });
});

describe("run_type migration", () => {
  test("migration adds run_type column to existing DB without it", () => {
    const db2 = new Database(":memory:", { create: true });
    db2.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
    `);
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );

    // Run the migration
    try {
      db2.exec("ALTER TABLE agent_runs ADD COLUMN run_type TEXT");
    } catch {
      // ignore duplicate column
    }

    // Pre-migration row should have null for the new column
    const row = db2
      .query<{ run_type: string | null }, [string]>(
        "SELECT run_type FROM agent_runs WHERE id = ?",
      )
      .get("pre-migration");
    expect(row?.run_type).toBeNull();

    // New rows inserted after migration can use the column
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at, run_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "post-migration",
        "ISSUE-2",
        "New Title",
        "completed",
        3000,
        4000,
        "executor",
      ],
    );
    const newRow = db2
      .query<{ run_type: string | null }, [string]>(
        "SELECT run_type FROM agent_runs WHERE id = ?",
      )
      .get("post-migration");
    expect(newRow?.run_type).toBe("executor");

    db2.close();
  });

  test("run_type migration is idempotent on a new DB", () => {
    // openDb on :memory: creates the schema then runs migrations including run_type
    // Running it again should not throw
    expect(() => openDb(":memory:")).not.toThrow();
  });
});

describe("insertAgentRun with runType", () => {
  test("stores and retrieves runType when set", async () => {
    await insertAgentRun(db, makeResult("a1", { runType: "executor" }));
    const run = getRecentRuns(db)[0];
    expect(run.runType).toBe("executor");
  });

  test("runType is undefined when not set", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.runType).toBeUndefined();
  });

  test("getRecentRuns returns runType for all run types", async () => {
    const types = ["executor", "fixer", "review", "planning", "project-owner"];
    for (const runType of types) {
      await insertAgentRun(
        db,
        makeResult(runType, { startedAt: 1000, finishedAt: 2000, runType }),
      );
    }
    const runs = getRecentRuns(db);
    const returnedTypes = runs.map((r) => r.runType);
    for (const runType of types) {
      expect(returnedTypes).toContain(runType);
    }
  });
});

describe("insertPlanningSession and getRecentPlanningSessions", () => {
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

  test("inserts and retrieves a planning session", async () => {
    await insertPlanningSession(db, makeSession("ps-1"));
    const sessions = getRecentPlanningSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ps-1");
    expect(sessions[0].agentRunId).toBe("run-ps-1");
    expect(sessions[0].status).toBe("completed");
    expect(sessions[0].issuesFiledCount).toBe(0);
  });

  test("retrieves sessions in newest-first order by finished_at", async () => {
    await insertPlanningSession(
      db,
      makeSession("ps-1", { startedAt: 1000, finishedAt: 2000 }),
    );
    await insertPlanningSession(
      db,
      makeSession("ps-2", { startedAt: 3000, finishedAt: 4000 }),
    );
    const sessions = getRecentPlanningSessions(db);
    expect(sessions[0].id).toBe("ps-2");
    expect(sessions[1].id).toBe("ps-1");
  });

  test("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await insertPlanningSession(
        db,
        makeSession(`ps-${i}`, {
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
        }),
      );
    }
    const sessions = getRecentPlanningSessions(db, 3);
    expect(sessions).toHaveLength(3);
  });

  test("default limit is 20", async () => {
    for (let i = 0; i < 25; i++) {
      await insertPlanningSession(
        db,
        makeSession(`ps-${i}`, {
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
        }),
      );
    }
    const sessions = getRecentPlanningSessions(db);
    expect(sessions).toHaveLength(20);
  });

  test("issuesFiled JSON field serializes and deserializes correctly", async () => {
    const issuesFiled = [
      { identifier: "ENG-1", title: "Fix the bug" },
      { identifier: "ENG-2", title: "Add the feature" },
    ];
    await insertPlanningSession(
      db,
      makeSession("ps-1", { issuesFiled, issuesFiledCount: 2 }),
    );
    const sessions = getRecentPlanningSessions(db);
    expect(sessions[0].issuesFiled).toEqual(issuesFiled);
    expect(sessions[0].issuesFiledCount).toBe(2);
  });

  test("findingsRejected JSON field serializes and deserializes correctly", async () => {
    const findingsRejected = [
      { finding: "Use better logging", reason: "Out of scope" },
    ];
    await insertPlanningSession(db, makeSession("ps-1", { findingsRejected }));
    const sessions = getRecentPlanningSessions(db);
    expect(sessions[0].findingsRejected).toEqual(findingsRejected);
  });

  test("optional fields are undefined when not set", async () => {
    await insertPlanningSession(db, makeSession("ps-1"));
    const session = getRecentPlanningSessions(db)[0];
    expect(session.summary).toBeUndefined();
    expect(session.issuesFiled).toBeUndefined();
    expect(session.findingsRejected).toBeUndefined();
    expect(session.costUsd).toBeUndefined();
  });

  test("stores and retrieves optional fields when set", async () => {
    await insertPlanningSession(
      db,
      makeSession("ps-1", {
        summary: "Planning complete",
        costUsd: 0.15,
        issuesFiledCount: 3,
      }),
    );
    const session = getRecentPlanningSessions(db)[0];
    expect(session.summary).toBe("Planning complete");
    expect(session.costUsd).toBe(0.15);
    expect(session.issuesFiledCount).toBe(3);
  });

  test("OR REPLACE upserts a session with the same id", async () => {
    await insertPlanningSession(
      db,
      makeSession("ps-1", { status: "completed" }),
    );
    await insertPlanningSession(db, makeSession("ps-1", { status: "failed" }));
    const sessions = getRecentPlanningSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("failed");
  });

  test("returns empty array when no sessions exist", () => {
    expect(getRecentPlanningSessions(db)).toEqual([]);
  });
});

describe("getFailuresByType", () => {
  test("returns correct counts for mixed statuses", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "completed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r3", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r4", { status: "timed_out", finishedAt: now }),
    );

    const result = getFailuresByType(db);
    expect(result).toHaveLength(2);
    const failedEntry = result.find((e) => e.status === "failed");
    const timedOutEntry = result.find((e) => e.status === "timed_out");
    expect(failedEntry?.count).toBe(2);
    expect(timedOutEntry?.count).toBe(1);
  });

  test("returns empty array when no failures exist", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "completed", finishedAt: now }),
    );
    expect(getFailuresByType(db)).toEqual([]);
  });

  test("returns empty array when database is empty", () => {
    expect(getFailuresByType(db)).toEqual([]);
  });

  test("respects days parameter — excludes runs outside the window", async () => {
    const now = Date.now();
    const outside = now - 31 * 24 * 60 * 60 * 1000;
    await insertAgentRun(
      db,
      makeResult("r1", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: outside }),
    );

    const result = getFailuresByType(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
  });

  test("orders results by count descending", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "timed_out", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r3", { status: "failed", finishedAt: now }),
    );

    const result = getFailuresByType(db);
    expect(result[0].status).toBe("failed");
    expect(result[0].count).toBe(2);
    expect(result[1].status).toBe("timed_out");
    expect(result[1].count).toBe(1);
  });
});

describe("getFailureTrend", () => {
  test("returns daily breakdown with correct failure rates", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "completed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r3", { status: "timed_out", finishedAt: now }),
    );

    const result = getFailureTrend(db);
    expect(result).toHaveLength(1);
    expect(result[0].totalRuns).toBe(3);
    expect(result[0].failureCount).toBe(2);
    expect(result[0].failureRate).toBeCloseTo(2 / 3);
  });

  test("failure rate is 0 for days where all runs completed", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "completed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "completed", finishedAt: now }),
    );

    const result = getFailureTrend(db);
    expect(result).toHaveLength(1);
    expect(result[0].failureCount).toBe(0);
    expect(result[0].failureRate).toBe(0);
  });

  test("respects days cutoff — excludes older runs", async () => {
    const now = Date.now();
    const outside = now - 31 * 24 * 60 * 60 * 1000;
    await insertAgentRun(
      db,
      makeResult("r1", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: outside }),
    );

    const result = getFailureTrend(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].totalRuns).toBe(1);
  });

  test("returns empty array when no runs exist", () => {
    expect(getFailureTrend(db)).toEqual([]);
  });

  test("orders results by date ascending", async () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    await insertAgentRun(
      db,
      makeResult("r1", { status: "failed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "failed", finishedAt: twoDaysAgo }),
    );

    const result = getFailureTrend(db);
    expect(result).toHaveLength(2);
    expect(result[0].date < result[1].date).toBe(true);
  });
});

describe("getRepeatFailures", () => {
  test("finds issues that failed multiple times", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", {
        issueId: "ENG-1",
        issueTitle: "Fix bug",
        status: "failed",
        finishedAt: now - 2000,
        error: "first error",
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", {
        issueId: "ENG-1",
        issueTitle: "Fix bug",
        status: "failed",
        finishedAt: now - 1000,
        error: "second error",
      }),
    );

    const result = getRepeatFailures(db);
    expect(result).toHaveLength(1);
    expect(result[0].issueId).toBe("ENG-1");
    expect(result[0].issueTitle).toBe("Fix bug");
    expect(result[0].failureCount).toBe(2);
  });

  test("returns correct lastError from most recent failure", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", {
        issueId: "ENG-1",
        issueTitle: "Fix bug",
        status: "failed",
        finishedAt: now - 2000,
        error: "old error",
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", {
        issueId: "ENG-1",
        issueTitle: "Fix bug",
        status: "timed_out",
        finishedAt: now - 1000,
        error: "latest error",
      }),
    );

    const result = getRepeatFailures(db);
    expect(result[0].lastError).toBe("latest error");
    expect(result[0].lastFailedAt).toBe(now - 1000);
  });

  test("excludes issues below minFailures threshold", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", {
        issueId: "ENG-1",
        issueTitle: "One fail",
        status: "failed",
        finishedAt: now,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", {
        issueId: "ENG-2",
        issueTitle: "Two fails",
        status: "failed",
        finishedAt: now - 1000,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r3", {
        issueId: "ENG-2",
        issueTitle: "Two fails",
        status: "failed",
        finishedAt: now - 500,
      }),
    );

    const result = getRepeatFailures(db, 2);
    expect(result).toHaveLength(1);
    expect(result[0].issueId).toBe("ENG-2");
  });

  test("returns empty array when all runs succeed", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", { status: "completed", finishedAt: now }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", { status: "completed", finishedAt: now }),
    );
    expect(getRepeatFailures(db)).toEqual([]);
  });

  test("returns empty array when no runs exist", () => {
    expect(getRepeatFailures(db)).toEqual([]);
  });

  test("respects days cutoff", async () => {
    const now = Date.now();
    const outside = now - 31 * 24 * 60 * 60 * 1000;
    await insertAgentRun(
      db,
      makeResult("r1", {
        issueId: "ENG-1",
        issueTitle: "Old fail",
        status: "failed",
        finishedAt: outside,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", {
        issueId: "ENG-1",
        issueTitle: "Old fail",
        status: "failed",
        finishedAt: outside - 1000,
      }),
    );

    const result = getRepeatFailures(db, 2, 30);
    expect(result).toEqual([]);
  });

  test("orders results by failure count descending", async () => {
    const now = Date.now();
    // ENG-1: 2 failures
    for (let i = 0; i < 2; i++) {
      await insertAgentRun(
        db,
        makeResult(`r1-${i}`, {
          issueId: "ENG-1",
          issueTitle: "Less fails",
          status: "failed",
          finishedAt: now - i * 1000,
        }),
      );
    }
    // ENG-2: 3 failures
    for (let i = 0; i < 3; i++) {
      await insertAgentRun(
        db,
        makeResult(`r2-${i}`, {
          issueId: "ENG-2",
          issueTitle: "More fails",
          status: "failed",
          finishedAt: now - i * 1000,
        }),
      );
    }

    const result = getRepeatFailures(db);
    expect(result[0].issueId).toBe("ENG-2");
    expect(result[0].failureCount).toBe(3);
    expect(result[1].issueId).toBe("ENG-1");
    expect(result[1].failureCount).toBe(2);
  });

  test("lastError is null when error field is not set", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("r1", {
        issueId: "ENG-1",
        issueTitle: "No error message",
        status: "failed",
        finishedAt: now - 1000,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("r2", {
        issueId: "ENG-1",
        issueTitle: "No error message",
        status: "failed",
        finishedAt: now,
      }),
    );

    const result = getRepeatFailures(db);
    expect(result[0].lastError).toBeNull();
  });
});

describe("exit_reason migration", () => {
  test("migration adds exit_reason column to existing DB without it", () => {
    const db2 = new Database(":memory:", { create: true });
    db2.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER,
        num_turns INTEGER,
        error TEXT
      );
    `);
    db2.run(
      `INSERT INTO agent_runs (id, issue_id, issue_title, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pre-migration", "ISSUE-1", "Old Title", "completed", 1000, 2000],
    );

    // Run the migration
    try {
      db2.exec("ALTER TABLE agent_runs ADD COLUMN exit_reason TEXT");
    } catch {
      // ignore duplicate column
    }

    // Pre-migration row should have null for the new column
    const row = db2
      .query<{ exit_reason: string | null }, [string]>(
        "SELECT exit_reason FROM agent_runs WHERE id = ?",
      )
      .get("pre-migration");
    expect(row?.exit_reason).toBeNull();

    db2.close();
  });

  test("exit_reason migration is idempotent on a new DB", () => {
    expect(() => openDb(":memory:")).not.toThrow();
  });
});

describe("insertAgentRun with exitReason", () => {
  test("stores and retrieves exitReason when set", async () => {
    await insertAgentRun(db, makeResult("a1", { exitReason: "success" }));
    const run = getRecentRuns(db)[0];
    expect(run.exitReason).toBe("success");
  });

  test("exitReason is undefined when not set", async () => {
    await insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.exitReason).toBeUndefined();
  });

  test("stores all ExitReason values correctly", async () => {
    const reasons = ["success", "timeout", "inactivity", "error"] as const;
    for (const reason of reasons) {
      await insertAgentRun(
        db,
        makeResult(`run-${reason}`, { exitReason: reason }),
      );
    }
    const runs = getRecentRuns(db, 10);
    const storedReasons = runs.map((r) => r.exitReason);
    for (const reason of reasons) {
      expect(storedReasons).toContain(reason);
    }
  });

  test("getUnreviewedRuns returns exitReason", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { status: "failed", exitReason: "error" }),
    );
    const runs = getUnreviewedRuns(db);
    expect(runs[0].exitReason).toBe("error");
  });

  test("getRunWithTranscript returns exitReason", async () => {
    await insertAgentRun(
      db,
      makeResult("a1", { exitReason: "inactivity", status: "timed_out" }),
    );
    const result = getRunWithTranscript(db, "a1");
    expect(result.run.exitReason).toBe("inactivity");
  });
});

describe("getDailyCostTrend", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  test("returns empty array for empty database", () => {
    expect(getDailyCostTrend(db)).toEqual([]);
  });

  test("single day with multiple runs aggregates cost and count", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("d1", { finishedAt: now, costUsd: 0.1 }),
    );
    await insertAgentRun(
      db,
      makeResult("d2", { finishedAt: now + 1000, costUsd: 0.2 }),
    );
    await insertAgentRun(
      db,
      makeResult("d3", { finishedAt: now + 2000, costUsd: 0.05 }),
    );
    const result = getDailyCostTrend(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].runCount).toBe(3);
    expect(result[0].totalCost).toBeCloseTo(0.35);
  });

  test("multiple days are returned in ascending date order", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("d1", { finishedAt: now - 2 * dayMs, costUsd: 0.1 }),
    );
    await insertAgentRun(
      db,
      makeResult("d2", { finishedAt: now - dayMs, costUsd: 0.2 }),
    );
    await insertAgentRun(
      db,
      makeResult("d3", { finishedAt: now, costUsd: 0.15 }),
    );
    const result = getDailyCostTrend(db, 30);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date > result[i - 1].date).toBe(true);
    }
  });

  test("runs with null cost_usd are counted but contribute 0 cost", async () => {
    const now = Date.now();
    await insertAgentRun(db, makeResult("d1", { finishedAt: now })); // no costUsd
    await insertAgentRun(
      db,
      makeResult("d2", { finishedAt: now + 1000, costUsd: 0.1 }),
    );
    const result = getDailyCostTrend(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].runCount).toBe(2);
    expect(result[0].totalCost).toBeCloseTo(0.1);
  });

  test("days parameter limits the time window", async () => {
    const now = Date.now();
    const fiftyDaysAgo = now - 50 * dayMs;
    await insertAgentRun(
      db,
      makeResult("d1", { finishedAt: fiftyDaysAgo, costUsd: 1.0 }),
    );
    await insertAgentRun(
      db,
      makeResult("d2", { finishedAt: now, costUsd: 0.1 }),
    );
    const result = getDailyCostTrend(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBeCloseTo(0.1);
  });

  test("date field has YYYY-MM-DD format", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("d1", { finishedAt: now, costUsd: 0.1 }),
    );
    const result = getDailyCostTrend(db, 30);
    expect(result[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getWeeklyCostTrend", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  test("returns empty array for empty database", () => {
    expect(getWeeklyCostTrend(db)).toEqual([]);
  });

  test("weekly aggregation groups runs from the same week together", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("w1", { finishedAt: now, costUsd: 0.1 }),
    );
    await insertAgentRun(
      db,
      makeResult("w2", { finishedAt: now + 3600000, costUsd: 0.2 }),
    );
    await insertAgentRun(
      db,
      makeResult("w3", { finishedAt: now + 7200000, costUsd: 0.15 }),
    );
    const result = getWeeklyCostTrend(db, 12);
    expect(result).toHaveLength(1);
    expect(result[0].runCount).toBe(3);
    expect(result[0].totalCost).toBeCloseTo(0.45);
  });

  test("weeks parameter limits the time window", async () => {
    const now = Date.now();
    const twentyWeeksAgo = now - 20 * 7 * dayMs;
    await insertAgentRun(
      db,
      makeResult("w1", { finishedAt: twentyWeeksAgo, costUsd: 5.0 }),
    );
    await insertAgentRun(
      db,
      makeResult("w2", { finishedAt: now, costUsd: 0.1 }),
    );
    const result = getWeeklyCostTrend(db, 12);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBeCloseTo(0.1);
  });

  test("weekStart field is a YYYY-MM-DD date string", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("w1", { finishedAt: now, costUsd: 0.1 }),
    );
    const result = getWeeklyCostTrend(db, 12);
    expect(result[0].weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("runs with null cost_usd contribute 0 cost but are counted", async () => {
    const now = Date.now();
    await insertAgentRun(db, makeResult("w1", { finishedAt: now })); // no costUsd
    const result = getWeeklyCostTrend(db, 12);
    expect(result).toHaveLength(1);
    expect(result[0].runCount).toBe(1);
    expect(result[0].totalCost).toBe(0);
  });
});

describe("getCostByStatus", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  test("returns empty array for empty database", () => {
    expect(getCostByStatus(db)).toEqual([]);
  });

  test("groups cost and count by status", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("s1", { finishedAt: now, status: "completed", costUsd: 0.1 }),
    );
    await insertAgentRun(
      db,
      makeResult("s2", {
        finishedAt: now + 1000,
        status: "completed",
        costUsd: 0.2,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("s3", {
        finishedAt: now + 2000,
        status: "failed",
        costUsd: 0.05,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("s4", {
        finishedAt: now + 3000,
        status: "timed_out",
        costUsd: 0.15,
      }),
    );
    const result = getCostByStatus(db, 30);
    expect(result).toHaveLength(3);
    const completed = result.find((r) => r.status === "completed");
    expect(completed?.runCount).toBe(2);
    expect(completed?.totalCost).toBeCloseTo(0.3);
    const failed = result.find((r) => r.status === "failed");
    expect(failed?.runCount).toBe(1);
    expect(failed?.totalCost).toBeCloseTo(0.05);
    const timedOut = result.find((r) => r.status === "timed_out");
    expect(timedOut?.runCount).toBe(1);
    expect(timedOut?.totalCost).toBeCloseTo(0.15);
  });

  test("days parameter limits the time window", async () => {
    const now = Date.now();
    const fiftyDaysAgo = now - 50 * dayMs;
    await insertAgentRun(
      db,
      makeResult("s1", {
        finishedAt: fiftyDaysAgo,
        status: "completed",
        costUsd: 1.0,
      }),
    );
    await insertAgentRun(
      db,
      makeResult("s2", { finishedAt: now, status: "completed", costUsd: 0.1 }),
    );
    const result = getCostByStatus(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBeCloseTo(0.1);
    expect(result[0].runCount).toBe(1);
  });

  test("runs with null cost_usd contribute 0 cost but are counted", async () => {
    const now = Date.now();
    await insertAgentRun(
      db,
      makeResult("s1", { finishedAt: now, status: "completed" }),
    ); // no costUsd
    const result = getCostByStatus(db, 30);
    expect(result).toHaveLength(1);
    expect(result[0].runCount).toBe(1);
    expect(result[0].totalCost).toBe(0);
  });
});

describe("OAuth token CRUD", () => {
  function makeToken(overrides?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  }) {
    return {
      accessToken: overrides?.accessToken ?? "access-tok",
      refreshToken: overrides?.refreshToken ?? "refresh-tok",
      expiresAt: overrides?.expiresAt ?? Date.now() + 3600_000,
      tokenType: "Bearer",
    };
  }

  test("saveOAuthToken stores a token and getOAuthToken retrieves it", async () => {
    await saveOAuthToken(db, "linear", makeToken({ accessToken: "my-tok" }));
    const result = getOAuthToken(db, "linear");
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("my-tok");
    expect(result?.refreshToken).toBe("refresh-tok");
    expect(result?.tokenType).toBe("Bearer");
  });

  test("getOAuthToken returns null when no token exists", () => {
    expect(getOAuthToken(db, "linear")).toBeNull();
    expect(getOAuthToken(db, "github")).toBeNull();
  });

  test("saveOAuthToken upserts (INSERT OR REPLACE) on same service", async () => {
    await saveOAuthToken(db, "linear", makeToken({ accessToken: "first" }));
    await saveOAuthToken(db, "linear", makeToken({ accessToken: "second" }));
    const result = getOAuthToken(db, "linear");
    expect(result?.accessToken).toBe("second");
  });

  test("deleteOAuthToken removes the token", async () => {
    await saveOAuthToken(db, "linear", makeToken());
    expect(getOAuthToken(db, "linear")).not.toBeNull();
    deleteOAuthToken(db, "linear");
    expect(getOAuthToken(db, "linear")).toBeNull();
  });

  test("deleteOAuthToken is a no-op when token does not exist", () => {
    expect(() => deleteOAuthToken(db, "nonexistent")).not.toThrow();
  });

  test("tokens are scoped by service key", async () => {
    await saveOAuthToken(db, "linear", makeToken({ accessToken: "lin-tok" }));
    await saveOAuthToken(db, "github", makeToken({ accessToken: "gh-tok" }));
    expect(getOAuthToken(db, "linear")?.accessToken).toBe("lin-tok");
    expect(getOAuthToken(db, "github")?.accessToken).toBe("gh-tok");
  });

  test("scope and actor are optional and default to undefined", async () => {
    await saveOAuthToken(db, "linear", makeToken());
    const result = getOAuthToken(db, "linear");
    expect(result?.scope).toBeUndefined();
    expect(result?.actor).toBeUndefined();
  });

  test("scope and actor are stored and retrieved when provided", async () => {
    await saveOAuthToken(db, "linear", {
      ...makeToken(),
      scope: "read write",
      actor: "application",
    });
    const result = getOAuthToken(db, "linear");
    expect(result?.scope).toBe("read write");
    expect(result?.actor).toBe("application");
  });
});
