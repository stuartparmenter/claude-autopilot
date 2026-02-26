import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityEntry, AgentResult } from "../state";

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
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_agent_run_id ON activity_logs(agent_run_id);
CREATE TABLE IF NOT EXISTS conversation_log (
  agent_run_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS linear_oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  service TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  token_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  actor TEXT NOT NULL
);
`;

export interface OAuthTokenRow {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
  actor: string;
}

export interface AnalyticsResult {
  totalRuns: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface TodayAnalyticsResult {
  todayRuns: number;
  todaySuccessRate: number;
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
  session_id: string | null;
  reviewed_at: number | null;
}

interface AnalyticsRow {
  total_runs: number;
  success_count: number;
  total_cost_usd: number | null;
  avg_duration_ms: number | null;
}

interface TodayAnalyticsRow {
  today_runs: number;
  today_success_count: number | null;
}

interface ActivityLogRow {
  agent_run_id: string;
  timestamp: number;
  type: "tool_use" | "text" | "result" | "error" | "status";
  summary: string;
  detail: string | null;
  is_subagent: number;
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
  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN session_id TEXT");
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN reviewed_at INTEGER");
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec(
      "ALTER TABLE activity_logs ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists — safe to ignore
  }
  return db;
}

export function insertAgentRun(db: Database, result: AgentResult): void {
  db.run(
    `INSERT OR REPLACE INTO agent_runs
     (id, issue_id, issue_title, status, started_at, finished_at, cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      result.sessionId ?? null,
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
    sessionId: row.session_id ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

export function getRecentRuns(db: Database, limit = 50): AgentResult[] {
  const rows = db
    .query<AgentRunRow, [number]>(
      `SELECT id, issue_id, issue_title, status, started_at, finished_at,
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at
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

export interface DailyCostEntry {
  date: string; // "YYYY-MM-DD"
  totalCost: number;
  runCount: number;
}

export interface WeeklyCostEntry {
  weekStart: string; // "YYYY-WW" (ISO year-week)
  totalCost: number;
  runCount: number;
}

export interface CostByStatusEntry {
  status: string;
  totalCost: number;
  runCount: number;
}

interface DailyCostRow {
  date: string;
  total_cost: number;
  run_count: number;
}

interface WeeklyCostRow {
  week: string;
  total_cost: number;
  run_count: number;
}

interface CostByStatusRow {
  status: string;
  total_cost: number;
  run_count: number;
}

export function getDailyCostTrend(db: Database, days = 30): DailyCostEntry[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .query<DailyCostRow, [number]>(
      `SELECT
         DATE(finished_at/1000, 'unixepoch') AS date,
         SUM(COALESCE(cost_usd, 0)) AS total_cost,
         COUNT(*) AS run_count
       FROM agent_runs
       WHERE finished_at >= ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(cutoffMs);
  return rows.map((row) => ({
    date: row.date,
    totalCost: row.total_cost,
    runCount: row.run_count,
  }));
}

export function getWeeklyCostTrend(db: Database, weeks = 8): WeeklyCostEntry[] {
  const cutoffMs = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
  const rows = db
    .query<WeeklyCostRow, [number]>(
      `SELECT
         strftime('%Y-%W', datetime(finished_at/1000, 'unixepoch')) AS week,
         SUM(COALESCE(cost_usd, 0)) AS total_cost,
         COUNT(*) AS run_count
       FROM agent_runs
       WHERE finished_at >= ?
       GROUP BY week
       ORDER BY week ASC`,
    )
    .all(cutoffMs);
  return rows.map((row) => ({
    weekStart: row.week,
    totalCost: row.total_cost,
    runCount: row.run_count,
  }));
}

export function getCostByStatus(db: Database): CostByStatusEntry[] {
  const rows = db
    .query<CostByStatusRow, []>(
      `SELECT
         status,
         SUM(COALESCE(cost_usd, 0)) AS total_cost,
         COUNT(*) AS run_count
       FROM agent_runs
       GROUP BY status
       ORDER BY status ASC`,
    )
    .all();
  return rows.map((row) => ({
    status: row.status,
    totalCost: row.total_cost,
    runCount: row.run_count,
  }));
}

export function getTodayAnalytics(db: Database): TodayAnalyticsResult {
  const now = new Date();
  const startOfTodayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  const row = db
    .query<TodayAnalyticsRow, [number]>(
      `SELECT
         COUNT(*) AS today_runs,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS today_success_count
       FROM agent_runs
       WHERE finished_at >= ?`,
    )
    .get(startOfTodayMs);

  const todayRuns = row?.today_runs ?? 0;
  const todaySuccessCount = row?.today_success_count ?? 0;

  return {
    todayRuns,
    todaySuccessRate: todayRuns > 0 ? todaySuccessCount / todayRuns : 0,
  };
}

export function insertActivityLogs(
  db: Database,
  agentRunId: string,
  activities: ActivityEntry[],
): void {
  if (activities.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO activity_logs (agent_run_id, timestamp, type, summary, detail, is_subagent) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: ActivityEntry[]) => {
    for (const row of rows) {
      stmt.run(
        agentRunId,
        row.timestamp,
        row.type,
        row.summary,
        row.detail ?? null,
        row.isSubagent ? 1 : 0,
      );
    }
  });
  insertMany(activities);
}

export function getActivityLogs(
  db: Database,
  agentRunId: string,
): ActivityEntry[] {
  const rows = db
    .query<ActivityLogRow, [string]>(
      `SELECT agent_run_id, timestamp, type, summary, detail, is_subagent
       FROM activity_logs
       WHERE agent_run_id = ?
       ORDER BY timestamp ASC`,
    )
    .all(agentRunId);
  return rows.map((row) => ({
    timestamp: row.timestamp,
    type: row.type,
    summary: row.summary,
    detail: row.detail ?? undefined,
    isSubagent: row.is_subagent === 1 || undefined,
  }));
}

export function pruneActivityLogs(db: Database, retentionDays: number): number {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.run(`DELETE FROM activity_logs WHERE timestamp < ?`, [
    cutoffMs,
  ]);
  return result.changes;
}

export function insertConversationLog(
  db: Database,
  agentRunId: string,
  messagesJson: string,
): void {
  db.run(
    `INSERT OR REPLACE INTO conversation_log (agent_run_id, messages_json, created_at) VALUES (?, ?, ?)`,
    [agentRunId, messagesJson, Date.now()],
  );
}

export function getConversationLog(
  db: Database,
  agentRunId: string,
): string | null {
  const row = db
    .query<{ messages_json: string }, [string]>(
      `SELECT messages_json FROM conversation_log WHERE agent_run_id = ?`,
    )
    .get(agentRunId);
  return row?.messages_json ?? null;
}

export function getOAuthToken(
  db: Database,
  service: string,
): OAuthTokenRow | null {
  const row = db
    .query<
      {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        token_type: string;
        scope: string;
        actor: string;
      },
      [string]
    >(
      `SELECT access_token, refresh_token, expires_at, token_type, scope, actor
       FROM oauth_tokens WHERE service = ?`,
    )
    .get(service);
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    tokenType: row.token_type,
    scope: row.scope,
    actor: row.actor,
  };
}

export function saveOAuthToken(
  db: Database,
  service: string,
  token: OAuthTokenRow,
): void {
  db.run(
    `INSERT OR REPLACE INTO oauth_tokens
     (service, access_token, refresh_token, expires_at, token_type, scope, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      service,
      token.accessToken,
      token.refreshToken,
      token.expiresAt,
      token.tokenType,
      token.scope,
      token.actor,
    ],
  );
}

export function pruneConversationLogs(
  db: Database,
  retentionDays: number,
): number {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.run(`DELETE FROM conversation_log WHERE created_at < ?`, [
    cutoffMs,
  ]);
  return result.changes;
}

export function getUnreviewedRuns(db: Database, limit = 100): AgentResult[] {
  const rows = db
    .query<AgentRunRow, [number]>(
      `SELECT id, issue_id, issue_title, status, started_at, finished_at,
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at
       FROM agent_runs
       WHERE reviewed_at IS NULL AND status IN ('completed', 'failed', 'timed_out')
       ORDER BY finished_at ASC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToResult);
}

export function getRunWithTranscript(
  db: Database,
  agentRunId: string,
): { run: AgentResult; messagesJson: string | null } {
  const runRow = db
    .query<AgentRunRow, [string]>(
      `SELECT id, issue_id, issue_title, status, started_at, finished_at,
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at
       FROM agent_runs WHERE id = ?`,
    )
    .get(agentRunId);

  if (!runRow) {
    throw new Error(`Agent run not found: ${agentRunId}`);
  }

  const logRow = db
    .query<{ messages_json: string }, [string]>(
      `SELECT messages_json FROM conversation_log WHERE agent_run_id = ?`,
    )
    .get(agentRunId);

  return {
    run: rowToResult(runRow),
    messagesJson: logRow?.messages_json ?? null,
  };
}

export function markRunsReviewed(db: Database, agentRunIds: string[]): void {
  if (agentRunIds.length === 0) return;
  const stmt = db.prepare(`UPDATE agent_runs SET reviewed_at = ? WHERE id = ?`);
  const updateMany = db.transaction((ids: string[]) => {
    const now = Date.now();
    for (const id of ids) {
      stmt.run(now, id);
    }
  });
  updateMany(agentRunIds);
}
