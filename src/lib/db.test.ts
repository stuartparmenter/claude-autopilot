import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityEntry, AgentResult } from "../state";
import {
  getActivityLogs,
  getAnalytics,
  getConversationLog,
  getRecentRuns,
  getRunWithTranscript,
  getUnreviewedRuns,
  insertActivityLogs,
  insertAgentRun,
  insertConversationLog,
  markRunsReviewed,
  openDb,
  pruneActivityLogs,
  pruneConversationLogs,
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

describe("insertAgentRun and getRecentRuns", () => {
  test("inserts and retrieves a run", () => {
    insertAgentRun(db, makeResult("a1"));
    const runs = getRecentRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("a1");
    expect(runs[0].issueId).toBe("ISSUE-a1");
    expect(runs[0].issueTitle).toBe("Title a1");
    expect(runs[0].status).toBe("completed");
  });

  test("retrieves runs in newest-first order by finished_at", () => {
    insertAgentRun(db, makeResult("a1", { startedAt: 1000, finishedAt: 2000 }));
    insertAgentRun(db, makeResult("a2", { startedAt: 3000, finishedAt: 4000 }));
    const runs = getRecentRuns(db);
    expect(runs[0].id).toBe("a2");
    expect(runs[1].id).toBe("a1");
  });

  test("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertAgentRun(
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

  test("stores and retrieves optional fields", () => {
    insertAgentRun(
      db,
      makeResult("a1", { costUsd: 0.05, durationMs: 30000, numTurns: 10 }),
    );
    const run = getRecentRuns(db)[0];
    expect(run.costUsd).toBe(0.05);
    expect(run.durationMs).toBe(30000);
    expect(run.numTurns).toBe(10);
  });

  test("optional fields are undefined when not set", () => {
    insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.costUsd).toBeUndefined();
    expect(run.durationMs).toBeUndefined();
    expect(run.numTurns).toBeUndefined();
    expect(run.error).toBeUndefined();
  });

  test("stores error field when set", () => {
    insertAgentRun(
      db,
      makeResult("a1", { status: "failed", error: "timeout" }),
    );
    const run = getRecentRuns(db)[0];
    expect(run.status).toBe("failed");
    expect(run.error).toBe("timeout");
  });

  test("stores and retrieves linearIssueId when set", () => {
    insertAgentRun(db, makeResult("a1", { linearIssueId: "uuid-1234-abcd" }));
    const run = getRecentRuns(db)[0];
    expect(run.linearIssueId).toBe("uuid-1234-abcd");
  });

  test("linearIssueId is undefined when not set", () => {
    insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.linearIssueId).toBeUndefined();
  });

  test("OR REPLACE upserts a run with the same id", () => {
    insertAgentRun(db, makeResult("a1", { status: "completed" }));
    insertAgentRun(db, makeResult("a1", { status: "failed" }));
    const runs = getRecentRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });

  test("returns empty array when no runs exist", () => {
    expect(getRecentRuns(db)).toEqual([]);
  });

  test("default limit is 50", () => {
    for (let i = 0; i < 60; i++) {
      insertAgentRun(
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

  test("calculates success rate correctly", () => {
    insertAgentRun(db, makeResult("a1", { status: "completed" }));
    insertAgentRun(db, makeResult("a2", { status: "completed" }));
    insertAgentRun(db, makeResult("a3", { status: "failed" }));
    insertAgentRun(db, makeResult("a4", { status: "timed_out" }));
    const result = getAnalytics(db);
    expect(result.totalRuns).toBe(4);
    expect(result.successRate).toBe(0.5);
  });

  test("success rate is 1.0 when all runs succeed", () => {
    insertAgentRun(db, makeResult("a1", { status: "completed" }));
    insertAgentRun(db, makeResult("a2", { status: "completed" }));
    const result = getAnalytics(db);
    expect(result.successRate).toBe(1.0);
  });

  test("success rate is 0 when all runs fail", () => {
    insertAgentRun(db, makeResult("a1", { status: "failed" }));
    const result = getAnalytics(db);
    expect(result.successRate).toBe(0);
  });

  test("sums total cost correctly", () => {
    insertAgentRun(db, makeResult("a1", { costUsd: 0.1 }));
    insertAgentRun(db, makeResult("a2", { costUsd: 0.2 }));
    const result = getAnalytics(db);
    expect(result.totalCostUsd).toBeCloseTo(0.3);
  });

  test("total cost is 0 when no cost data", () => {
    insertAgentRun(db, makeResult("a1"));
    const result = getAnalytics(db);
    expect(result.totalCostUsd).toBe(0);
  });

  test("averages duration correctly", () => {
    insertAgentRun(db, makeResult("a1", { durationMs: 1000 }));
    insertAgentRun(db, makeResult("a2", { durationMs: 3000 }));
    const result = getAnalytics(db);
    expect(result.avgDurationMs).toBe(2000);
  });

  test("avg duration is 0 when no duration data", () => {
    insertAgentRun(db, makeResult("a1"));
    const result = getAnalytics(db);
    expect(result.avgDurationMs).toBe(0);
  });

  test("counts total runs correctly", () => {
    for (let i = 0; i < 5; i++) {
      insertAgentRun(db, makeResult(`a${i}`));
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

  test("insertActivityLogs with empty array is a no-op", () => {
    expect(() => insertActivityLogs(db, "run-1", [])).not.toThrow();
    expect(getActivityLogs(db, "run-1")).toEqual([]);
  });

  test("inserts and retrieves activity logs in timestamp order", () => {
    const activities: ActivityEntry[] = [
      makeActivity({ timestamp: 3000, type: "text", summary: "Third" }),
      makeActivity({ timestamp: 1000, type: "tool_use", summary: "First" }),
      makeActivity({ timestamp: 2000, type: "result", summary: "Second" }),
    ];
    insertActivityLogs(db, "run-1", activities);
    const logs = getActivityLogs(db, "run-1");
    expect(logs).toHaveLength(3);
    expect(logs[0].summary).toBe("First");
    expect(logs[1].summary).toBe("Second");
    expect(logs[2].summary).toBe("Third");
  });

  test("retrieves all five entries inserted", () => {
    const activities: ActivityEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeActivity({ timestamp: i * 1000, summary: `Entry ${i}` }),
    );
    insertActivityLogs(db, "run-1", activities);
    const logs = getActivityLogs(db, "run-1");
    expect(logs).toHaveLength(5);
  });

  test("returns empty array for unknown agentRunId", () => {
    expect(getActivityLogs(db, "nonexistent")).toEqual([]);
  });

  test("stores and retrieves detail field", () => {
    const activity = makeActivity({ detail: "some detail text" });
    insertActivityLogs(db, "run-1", [activity]);
    const logs = getActivityLogs(db, "run-1");
    expect(logs[0].detail).toBe("some detail text");
  });

  test("detail is undefined when not set", () => {
    const activity = makeActivity();
    insertActivityLogs(db, "run-1", [activity]);
    const logs = getActivityLogs(db, "run-1");
    expect(logs[0].detail).toBeUndefined();
  });

  test("isolates logs by agentRunId", () => {
    insertActivityLogs(db, "run-1", [makeActivity({ summary: "Run 1 entry" })]);
    insertActivityLogs(db, "run-2", [makeActivity({ summary: "Run 2 entry" })]);
    expect(getActivityLogs(db, "run-1")).toHaveLength(1);
    expect(getActivityLogs(db, "run-1")[0].summary).toBe("Run 1 entry");
    expect(getActivityLogs(db, "run-2")).toHaveLength(1);
  });
});

describe("pruneActivityLogs", () => {
  test("deletes entries older than retention window", () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    insertActivityLogs(db, "run-old", [
      { timestamp: thirtyOneDaysAgo, type: "text", summary: "Old entry" },
    ]);
    insertActivityLogs(db, "run-new", [
      { timestamp: now, type: "text", summary: "New entry" },
    ]);
    const deleted = pruneActivityLogs(db, 30);
    expect(deleted).toBe(1);
    expect(getActivityLogs(db, "run-old")).toHaveLength(0);
    expect(getActivityLogs(db, "run-new")).toHaveLength(1);
  });

  test("returns 0 when no entries are old enough to prune", () => {
    const now = Date.now();
    insertActivityLogs(db, "run-1", [
      { timestamp: now, type: "text", summary: "Recent entry" },
    ]);
    const deleted = pruneActivityLogs(db, 30);
    expect(deleted).toBe(0);
  });

  test("returns 0 on empty table", () => {
    expect(pruneActivityLogs(db, 30)).toBe(0);
  });

  test("preserves entries within the retention window", () => {
    const now = Date.now();
    const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;
    insertActivityLogs(db, "run-1", [
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
  test("stores and retrieves sessionId", () => {
    insertAgentRun(db, makeResult("a1", { sessionId: "sess-abc-123" }));
    const run = getRecentRuns(db)[0];
    expect(run.sessionId).toBe("sess-abc-123");
  });

  test("sessionId is undefined when not set", () => {
    insertAgentRun(db, makeResult("a1"));
    const run = getRecentRuns(db)[0];
    expect(run.sessionId).toBeUndefined();
  });

  test("getRecentRuns does not include messagesJson field", () => {
    insertAgentRun(db, makeResult("a1", { sessionId: "sess-xyz" }));
    const run = getRecentRuns(db)[0];
    expect(
      (run as unknown as Record<string, unknown>).messagesJson,
    ).toBeUndefined();
  });
});

describe("insertConversationLog and getConversationLog", () => {
  test("round-trip stores and retrieves messages JSON", () => {
    insertAgentRun(db, makeResult("run-1"));
    const messages = [
      { type: "text", content: "hello" },
      { type: "result", content: "done" },
    ];
    insertConversationLog(db, "run-1", JSON.stringify(messages));
    const retrieved = getConversationLog(db, "run-1");
    expect(retrieved).not.toBeNull();
    expect(JSON.parse(retrieved as string)).toEqual(messages);
  });

  test("getConversationLog returns null for unknown run ID", () => {
    expect(getConversationLog(db, "nonexistent-run")).toBeNull();
  });

  test("INSERT OR REPLACE overwrites existing log for same run ID", () => {
    insertAgentRun(db, makeResult("run-1"));
    insertConversationLog(db, "run-1", JSON.stringify(["first"]));
    insertConversationLog(db, "run-1", JSON.stringify(["second"]));
    const retrieved = getConversationLog(db, "run-1");
    expect(retrieved).not.toBeNull();
    expect(JSON.parse(retrieved as string)).toEqual(["second"]);
  });
});

describe("pruneConversationLogs", () => {
  test("deletes entries older than retention window", () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    insertAgentRun(db, makeResult("run-old"));
    insertAgentRun(db, makeResult("run-new"));
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

  test("returns 0 when no entries are old enough to prune", () => {
    insertAgentRun(db, makeResult("run-1"));
    insertConversationLog(db, "run-1", "[]");
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
  test("returns only runs where reviewed_at IS NULL", () => {
    insertAgentRun(db, makeResult("r1", { status: "completed" }));
    insertAgentRun(db, makeResult("r2", { status: "failed" }));
    insertAgentRun(db, makeResult("r3", { status: "timed_out" }));
    markRunsReviewed(db, ["r1"]);

    const runs = getUnreviewedRuns(db);
    expect(runs).toHaveLength(2);
    const ids = runs.map((r) => r.id);
    expect(ids).not.toContain("r1");
    expect(ids).toContain("r2");
    expect(ids).toContain("r3");
  });

  test("returns runs in ascending finished_at order", () => {
    insertAgentRun(db, makeResult("r1", { startedAt: 3000, finishedAt: 4000 }));
    insertAgentRun(db, makeResult("r2", { startedAt: 1000, finishedAt: 2000 }));

    const runs = getUnreviewedRuns(db);
    expect(runs[0].id).toBe("r2");
    expect(runs[1].id).toBe("r1");
  });

  test("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      insertAgentRun(
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

  test("returns empty array when all runs are reviewed", () => {
    insertAgentRun(db, makeResult("r1"));
    markRunsReviewed(db, ["r1"]);
    expect(getUnreviewedRuns(db)).toHaveLength(0);
  });

  test("returns empty array when no runs exist", () => {
    expect(getUnreviewedRuns(db)).toHaveLength(0);
  });
});

describe("getRunWithTranscript", () => {
  test("returns run metadata and null messagesJson when no conversation log", () => {
    insertAgentRun(db, makeResult("r1", { status: "completed" }));
    const result = getRunWithTranscript(db, "r1");
    expect(result.run.id).toBe("r1");
    expect(result.run.status).toBe("completed");
    expect(result.messagesJson).toBeNull();
  });

  test("returns run metadata and messagesJson when conversation log exists", () => {
    insertAgentRun(db, makeResult("r1"));
    const messages = [{ type: "text", content: "hello" }];
    insertConversationLog(db, "r1", JSON.stringify(messages));

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
  test("sets reviewed_at for the specified run IDs", () => {
    insertAgentRun(db, makeResult("r1"));
    insertAgentRun(db, makeResult("r2"));

    markRunsReviewed(db, ["r1"]);

    const unreviewedAfter = getUnreviewedRuns(db);
    expect(unreviewedAfter).toHaveLength(1);
    expect(unreviewedAfter[0].id).toBe("r2");
  });

  test("is a no-op for empty array", () => {
    insertAgentRun(db, makeResult("r1"));
    expect(() => markRunsReviewed(db, [])).not.toThrow();
    expect(getUnreviewedRuns(db)).toHaveLength(1);
  });

  test("batch-updates multiple run IDs", () => {
    insertAgentRun(db, makeResult("r1"));
    insertAgentRun(db, makeResult("r2"));
    insertAgentRun(db, makeResult("r3"));

    markRunsReviewed(db, ["r1", "r2"]);

    const unreviewed = getUnreviewedRuns(db);
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0].id).toBe("r3");
  });

  test("reviewedAt is set on results returned from getRecentRuns after marking", () => {
    insertAgentRun(db, makeResult("r1"));
    markRunsReviewed(db, ["r1"]);

    const runs = getRecentRuns(db);
    expect(runs[0].reviewedAt).toBeDefined();
    expect(typeof runs[0].reviewedAt).toBe("number");
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
