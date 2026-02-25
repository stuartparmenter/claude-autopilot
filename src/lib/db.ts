import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentResult } from "../state";

const SCHEMA = `
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
  error TEXT,
  linear_issue_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_finished_at ON agent_runs(finished_at);
`;

export interface AnalyticsResult {
  totalRuns: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

interface AgentRunRow {
  id: string;
  issue_id: string;
  issue_title: string;
  status: "completed" | "failed" | "timed_out";
  started_at: number;
  finished_at: number;
  cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  error: string | null;
  linear_issue_id: string | null;
}

interface AnalyticsRow {
  total_runs: number;
  success_count: number;
  total_cost_usd: number | null;
  avg_duration_ms: number | null;
}

export function openDb(dbFilePath: string): Database {
  if (dbFilePath !== ":memory:") {
    mkdirSync(dirname(dbFilePath), { recursive: true });
  }
  const db = new Database(dbFilePath, { create: true });
  db.exec(SCHEMA);
  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN linear_issue_id TEXT");
  } catch {
    // Column already exists — safe to ignore
  }
  return db;
}

export function insertAgentRun(db: Database, result: AgentResult): void {
  db.run(
    `INSERT OR REPLACE INTO agent_runs
     (id, issue_id, issue_title, status, started_at, finished_at, cost_usd, duration_ms, num_turns, error, linear_issue_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      result.id,
      result.issueId,
      result.issueTitle,
      result.status,
      result.startedAt,
      result.finishedAt,
      result.costUsd ?? null,
      result.durationMs ?? null,
      result.numTurns ?? null,
      result.error ?? null,
      result.linearIssueId ?? null,
    ],
  );
}

function rowToResult(row: AgentRunRow): AgentResult {
  return {
    id: row.id,
    issueId: row.issue_id,
    issueTitle: row.issue_title,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    costUsd: row.cost_usd ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    numTurns: row.num_turns ?? undefined,
    error: row.error ?? undefined,
    linearIssueId: row.linear_issue_id ?? undefined,
  };
}

export function getRecentRuns(db: Database, limit = 50): AgentResult[] {
  const rows = db
    .query<AgentRunRow, [number]>(
      `SELECT id, issue_id, issue_title, status, started_at, finished_at,
              cost_usd, duration_ms, num_turns, error, linear_issue_id
       FROM agent_runs
       ORDER BY finished_at DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToResult);
}

export function getAnalytics(db: Database): AnalyticsResult {
  const row = db
    .query<AnalyticsRow, []>(
      `SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
         SUM(cost_usd) AS total_cost_usd,
         AVG(duration_ms) AS avg_duration_ms
       FROM agent_runs`,
    )
    .get();

  const totalRuns = row?.total_runs ?? 0;
  const successCount = row?.success_count ?? 0;

  return {
    totalRuns,
    successRate: totalRuns > 0 ? successCount / totalRuns : 0,
    totalCostUsd: row?.total_cost_usd ?? 0,
    avgDurationMs: row?.avg_duration_ms ?? 0,
  };
}
