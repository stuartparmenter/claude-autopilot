import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityEntry, AgentResult, PlanningSession } from "../state";
import { error, warn } from "./logger";

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
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT,
  actor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS planning_sessions (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  issues_filed_count INTEGER NOT NULL DEFAULT 0,
  issues_filed_json TEXT,
  findings_rejected_json TEXT,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_planning_sessions_finished_at ON planning_sessions(finished_at);
`;

// ---- SQLITE_BUSY retry logic ----

/**
 * Returns true for SQLITE_BUSY (code 5) and SQLITE_LOCKED (code 6) errors.
 * These are transient lock-contention errors that can be retried.
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Bun's SQLiteError exposes an 'errno' property with the SQLite error code.
  const e = err as Error & { errno?: unknown; code?: unknown };
  if (typeof e.errno === "number") return e.errno === 5 || e.errno === 6;
  if (typeof e.code === "number") return e.code === 5 || e.code === 6;
  const msg = err.message.toLowerCase();
  return msg.includes("sqlite_busy") || msg.includes("database is locked");
}

interface DbRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Retry a synchronous SQLite write operation on SQLITE_BUSY with exponential
 * backoff + jitter. Consistent with the withRetry() pattern in retry.ts, but
 * without circuit-breaker integration (SQLite is a local resource, not a remote
 * service). On exhaustion, logs an error with the full context data before
 * rethrowing so the data is never silently lost.
 */
async function withDbRetry<T>(
  fn: () => T,
  label: string,
  context: unknown,
  opts: DbRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 50;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === maxAttempts || !isSqliteBusy(err)) {
        if (isSqliteBusy(err)) {
          error(
            `[${label}] SQLITE_BUSY after ${maxAttempts} attempts — data not saved: ${JSON.stringify(context)}`,
          );
        }
        throw err;
      }
      const expo = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * 0.3 * expo;
      const delayMs = Math.round(Math.min(expo + jitter, maxDelayMs));
      warn(
        `[${label}] attempt ${attempt}/${maxAttempts} failed (SQLITE_BUSY) — retrying in ${delayMs}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

export interface OAuthTokenRow {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
  tokenType: string;
  scope?: string;
  actor?: string;
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
  exit_reason: string | null;
  run_type: string | null;
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
  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN exit_reason TEXT");
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN run_type TEXT");
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec(
      "ALTER TABLE oauth_tokens ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists — safe to ignore
  }
  return db;
}

export async function insertAgentRun(
  db: Database,
  result: AgentResult,
): Promise<void> {
  await withDbRetry(
    () =>
      db.run(
        `INSERT OR REPLACE INTO agent_runs
         (id, issue_id, issue_title, status, started_at, finished_at, cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, exit_reason, run_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          result.exitReason ?? null,
          result.runType ?? null,
        ],
      ),
    "insertAgentRun",
    result,
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
    exitReason: row.exit_reason ?? undefined,
    runType: row.run_type ?? undefined,
  };
}

export function getRecentRuns(db: Database, limit = 50): AgentResult[] {
  const rows = db
    .query<AgentRunRow, [number]>(
      `SELECT id, issue_id, issue_title, status, started_at, finished_at,
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at, exit_reason, run_type
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
  weekStart: string; // "YYYY-MM-DD" (earliest date of runs in the week)
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
  week_start: string;
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

export function getWeeklyCostTrend(
  db: Database,
  weeks = 12,
): WeeklyCostEntry[] {
  const cutoffMs = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
  const rows = db
    .query<WeeklyCostRow, [number]>(
      `SELECT
         strftime('%Y-%W', finished_at/1000, 'unixepoch') AS week,
         MIN(strftime('%Y-%m-%d', finished_at/1000, 'unixepoch')) AS week_start,
         SUM(COALESCE(cost_usd, 0)) AS total_cost,
         COUNT(*) AS run_count
       FROM agent_runs
       WHERE finished_at >= ?
       GROUP BY week
       ORDER BY week ASC`,
    )
    .all(cutoffMs);
  return rows.map((row) => ({
    weekStart: row.week_start,
    totalCost: row.total_cost,
    runCount: row.run_count,
  }));
}

export function getCostByStatus(db: Database, days = 30): CostByStatusEntry[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .query<CostByStatusRow, [number]>(
      `SELECT
         status,
         SUM(COALESCE(cost_usd, 0)) AS total_cost,
         COUNT(*) AS run_count
       FROM agent_runs
       WHERE finished_at >= ?
       GROUP BY status
       ORDER BY status ASC`,
    )
    .all(cutoffMs);
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

export async function insertActivityLogs(
  db: Database,
  agentRunId: string,
  activities: ActivityEntry[],
): Promise<void> {
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
  await withDbRetry(() => insertMany(activities), "insertActivityLogs", {
    agentRunId,
    count: activities.length,
  });
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

export async function insertConversationLog(
  db: Database,
  agentRunId: string,
  messagesJson: string,
): Promise<void> {
  await withDbRetry(
    () =>
      db.run(
        `INSERT OR REPLACE INTO conversation_log (agent_run_id, messages_json, created_at) VALUES (?, ?, ?)`,
        [agentRunId, messagesJson, Date.now()],
      ),
    "insertConversationLog",
    { agentRunId },
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
        scope: string | null;
        actor: string | null;
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
    scope: row.scope ?? undefined,
    actor: row.actor ?? undefined,
  };
}

export async function saveOAuthToken(
  db: Database,
  service: string,
  token: OAuthTokenRow,
): Promise<void> {
  await withDbRetry(
    () =>
      db.run(
        `INSERT OR REPLACE INTO oauth_tokens
         (service, access_token, refresh_token, expires_at, token_type, scope, actor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          service,
          token.accessToken,
          token.refreshToken,
          token.expiresAt,
          token.tokenType,
          token.scope ?? null,
          token.actor ?? null,
          Date.now(),
        ],
      ),
    "saveOAuthToken",
    { service },
  );
}

export function deleteOAuthToken(db: Database, service: string): void {
  db.run("DELETE FROM oauth_tokens WHERE service = ?", [service]);
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
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at, exit_reason, run_type
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
              cost_usd, duration_ms, num_turns, error, linear_issue_id, session_id, reviewed_at, exit_reason, run_type
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

export interface FailuresByTypeEntry {
  status: string; // "failed" | "timed_out"
  count: number;
}

export interface FailureTrendEntry {
  date: string; // "YYYY-MM-DD"
  totalRuns: number;
  failureCount: number;
  failureRate: number; // 0.0 - 1.0
}

export interface RepeatFailureEntry {
  issueId: string;
  issueTitle: string;
  failureCount: number;
  lastFailedAt: number; // ms timestamp
  lastError: string | null;
}

interface FailuresByTypeRow {
  status: string;
  count: number;
}

interface FailureTrendRow {
  date: string;
  total_runs: number;
  failure_count: number;
}

interface RepeatFailureRow {
  issue_id: string;
  issue_title: string;
  failure_count: number;
  last_failed_at: number;
  last_error: string | null;
}

export function getFailuresByType(
  db: Database,
  days = 30,
): FailuresByTypeEntry[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .query<FailuresByTypeRow, [number]>(
      `SELECT status, COUNT(*) AS count
       FROM agent_runs
       WHERE status != 'completed' AND finished_at >= ?
       GROUP BY status
       ORDER BY count DESC`,
    )
    .all(cutoffMs);
  return rows.map((row) => ({
    status: row.status,
    count: row.count,
  }));
}

export function getFailureTrend(db: Database, days = 30): FailureTrendEntry[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .query<FailureTrendRow, [number]>(
      `SELECT
         DATE(finished_at/1000, 'unixepoch') AS date,
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS failure_count
       FROM agent_runs
       WHERE finished_at >= ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(cutoffMs);
  return rows.map((row) => ({
    date: row.date,
    totalRuns: row.total_runs,
    failureCount: row.failure_count,
    failureRate: row.total_runs > 0 ? row.failure_count / row.total_runs : 0,
  }));
}

export function getRepeatFailures(
  db: Database,
  minFailures = 2,
  days = 30,
): RepeatFailureEntry[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .query<RepeatFailureRow, [number, number]>(
      `SELECT
         issue_id,
         issue_title,
         COUNT(*) AS failure_count,
         MAX(finished_at) AS last_failed_at,
         (SELECT error FROM agent_runs ar2
          WHERE ar2.issue_id = agent_runs.issue_id
            AND ar2.status != 'completed'
          ORDER BY ar2.finished_at DESC
          LIMIT 1) AS last_error
       FROM agent_runs
       WHERE status != 'completed' AND finished_at >= ?
       GROUP BY issue_id
       HAVING COUNT(*) >= ?
       ORDER BY failure_count DESC`,
    )
    .all(cutoffMs, minFailures);
  return rows.map((row) => ({
    issueId: row.issue_id,
    issueTitle: row.issue_title,
    failureCount: row.failure_count,
    lastFailedAt: row.last_failed_at,
    lastError: row.last_error,
  }));
}

export async function markRunsReviewed(
  db: Database,
  agentRunIds: string[],
): Promise<void> {
  if (agentRunIds.length === 0) return;
  const stmt = db.prepare(`UPDATE agent_runs SET reviewed_at = ? WHERE id = ?`);
  const updateMany = db.transaction((ids: string[]) => {
    const now = Date.now();
    for (const id of ids) {
      stmt.run(now, id);
    }
  });
  await withDbRetry(() => updateMany(agentRunIds), "markRunsReviewed", {
    ids: agentRunIds,
  });
}

interface PlanningSessionRow {
  id: string;
  agent_run_id: string;
  started_at: number;
  finished_at: number;
  status: "completed" | "failed" | "timed_out";
  summary: string | null;
  issues_filed_count: number;
  issues_filed_json: string | null;
  findings_rejected_json: string | null;
  cost_usd: number | null;
}

export async function insertPlanningSession(
  db: Database,
  session: PlanningSession,
): Promise<void> {
  await withDbRetry(
    () =>
      db.run(
        `INSERT OR REPLACE INTO planning_sessions
         (id, agent_run_id, started_at, finished_at, status, summary, issues_filed_count, issues_filed_json, findings_rejected_json, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.agentRunId,
          session.startedAt,
          session.finishedAt,
          session.status,
          session.summary ?? null,
          session.issuesFiledCount,
          session.issuesFiled ? JSON.stringify(session.issuesFiled) : null,
          session.findingsRejected
            ? JSON.stringify(session.findingsRejected)
            : null,
          session.costUsd ?? null,
        ],
      ),
    "insertPlanningSession",
    session,
  );
}

export function getRecentPlanningSessions(
  db: Database,
  limit = 20,
): PlanningSession[] {
  const rows = db
    .query<PlanningSessionRow, [number]>(
      `SELECT id, agent_run_id, started_at, finished_at, status, summary,
              issues_filed_count, issues_filed_json, findings_rejected_json, cost_usd
       FROM planning_sessions
       ORDER BY finished_at DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => ({
    id: row.id,
    agentRunId: row.agent_run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    summary: row.summary ?? undefined,
    issuesFiledCount: row.issues_filed_count,
    issuesFiled: row.issues_filed_json
      ? (JSON.parse(row.issues_filed_json) as Array<{
          identifier: string;
          title: string;
        }>)
      : undefined,
    findingsRejected: row.findings_rejected_json
      ? (JSON.parse(row.findings_rejected_json) as Array<{
          finding: string;
          reason: string;
        }>)
      : undefined,
    costUsd: row.cost_usd ?? undefined,
  }));
}
