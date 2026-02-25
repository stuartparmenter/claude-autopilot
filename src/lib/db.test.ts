import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentResult } from "../state";
import { getAnalytics, getRecentRuns, insertAgentRun, openDb } from "./db";

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
