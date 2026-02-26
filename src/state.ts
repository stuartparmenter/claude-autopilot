import type { Database } from "bun:sqlite";
import { type CircuitState, defaultRegistry } from "./lib/circuit-breaker";
import { type AutopilotConfig, DEFAULTS } from "./lib/config";
import type { AnalyticsResult, TodayAnalyticsResult } from "./lib/db";
import {
  getActivityLogs,
  getAnalytics,
  getRecentRuns,
  getTodayAnalytics,
  insertActivityLogs,
  insertAgentRun,
  insertConversationLog,
} from "./lib/db";
import { sanitizeMessage } from "./lib/sanitize";

export interface ActivityEntry {
  timestamp: number;
  type: "tool_use" | "text" | "result" | "error" | "status";
  summary: string;
  detail?: string;
}

export interface AgentState {
  id: string;
  issueId: string;
  issueTitle: string;
  linearIssueId?: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "timed_out";
  activities: ActivityEntry[];
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
}

export interface AgentResult {
  id: string;
  issueId: string;
  issueTitle: string;
  linearIssueId?: string;
  status: "completed" | "failed" | "timed_out";
  startedAt: number;
  finishedAt: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  sessionId?: string;
  error?: string;
  reviewedAt?: number;
}

export interface QueueInfo {
  readyCount: number;
  inProgressCount: number;
  lastChecked: number;
}

export interface PlanningStatus {
  running: boolean;
  lastRunAt?: number;
  lastResult?: "completed" | "skipped" | "failed" | "timed_out";
  readyCount?: number;
  threshold?: number;
}

export interface ReviewerStatus {
  running: boolean;
  lastRunAt?: number;
  lastResult?: "completed" | "skipped" | "failed" | "timed_out";
}

export interface ApiHealthStatus {
  linear: CircuitState;
  github: CircuitState;
}

export interface AppStateSnapshot {
  paused: boolean;
  agents: AgentState[];
  history: AgentResult[];
  queue: QueueInfo;
  planning: PlanningStatus;
  reviewer: ReviewerStatus;
  startedAt: number;
  apiHealth: ApiHealthStatus;
}

const MAX_HISTORY = 50;
const MAX_ACTIVITIES_PER_AGENT = 200;
const MAX_FAILURE_ENTRIES = 1000;

export class AppState {
  private agents = new Map<string, AgentState>();
  private history: AgentResult[] = [];
  private controllers = new Map<string, AbortController>();
  private queue: QueueInfo = {
    readyCount: 0,
    inProgressCount: 0,
    lastChecked: 0,
  };
  private planning: PlanningStatus = { running: false };
  private reviewer: ReviewerStatus = { running: false };
  private paused = false;
  private issueFailureCount = new Map<string, number>();
  private db: Database | null = null;
  private spendLog: Array<{ timestampMs: number; costUsd: number }> = [];
  private maxParallel: number;
  readonly startedAt = Date.now();

  constructor(maxParallel = DEFAULTS.executor.parallel) {
    this.maxParallel = maxParallel;
  }

  setDb(db: Database): void {
    this.db = db;
    this.history = getRecentRuns(db, MAX_HISTORY);
  }

  addAgent(
    id: string,
    issueId: string,
    issueTitle: string,
    linearIssueId?: string,
  ): void {
    this.agents.set(id, {
      id,
      issueId,
      issueTitle,
      linearIssueId,
      startedAt: Date.now(),
      status: "running",
      activities: [],
    });
  }

  addActivity(agentId: string, entry: ActivityEntry): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.activities.push(entry);
    if (agent.activities.length > MAX_ACTIVITIES_PER_AGENT) {
      agent.activities = agent.activities.slice(-MAX_ACTIVITIES_PER_AGENT);
    }
  }

  completeAgent(
    agentId: string,
    status: "completed" | "failed" | "timed_out",
    meta?: {
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      sessionId?: string;
      error?: string;
    },
    rawMessages?: unknown[],
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = status;
    if (meta) {
      const sanitized =
        meta.error !== undefined
          ? { ...meta, error: sanitizeMessage(meta.error) }
          : meta;
      Object.assign(agent, sanitized);
    }

    const result: AgentResult = {
      id: agent.id,
      issueId: agent.issueId,
      issueTitle: agent.issueTitle,
      linearIssueId: agent.linearIssueId,
      status,
      startedAt: agent.startedAt,
      finishedAt: Date.now(),
      costUsd: agent.costUsd,
      durationMs: agent.durationMs,
      numTurns: agent.numTurns,
      sessionId: meta?.sessionId,
      error: agent.error,
    };

    if (this.db) {
      insertAgentRun(this.db, result);
      insertActivityLogs(this.db, result.id, agent.activities);
      if (rawMessages && rawMessages.length > 0) {
        insertConversationLog(this.db, result.id, JSON.stringify(rawMessages));
      }
    }

    if (meta?.costUsd && meta.costUsd > 0) {
      this.addSpend(meta.costUsd);
    }

    this.history.unshift(result);

    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(0, MAX_HISTORY);
    }

    this.controllers.delete(agentId);
    this.agents.delete(agentId);
  }

  registerAgentController(agentId: string, controller: AbortController): void {
    this.controllers.set(agentId, controller);
  }

  cancelAgent(agentId: string): boolean {
    const controller = this.controllers.get(agentId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(agentId);
    return true;
  }

  updateQueue(readyCount: number, inProgressCount: number): void {
    this.queue = { readyCount, inProgressCount, lastChecked: Date.now() };
  }

  updatePlanning(status: Partial<PlanningStatus>): void {
    Object.assign(this.planning, status);
  }

  getAgent(id: string): AgentState | undefined {
    return this.agents.get(id);
  }

  getRunningAgents(): AgentState[] {
    return [...this.agents.values()];
  }

  getRunningCount(): number {
    return this.agents.size;
  }

  getMaxParallel(): number {
    return this.maxParallel;
  }

  getHistory(): AgentResult[] {
    return this.history;
  }

  getAnalytics(): AnalyticsResult | null {
    if (!this.db) return null;
    return getAnalytics(this.db);
  }

  getTodayAnalytics(): TodayAnalyticsResult | null {
    if (!this.db) return null;
    return getTodayAnalytics(this.db);
  }

  getActivityLogsForRun(agentRunId: string): ActivityEntry[] {
    if (!this.db) return [];
    return getActivityLogs(this.db, agentRunId);
  }

  getPlanningStatus(): PlanningStatus {
    return this.planning;
  }

  updateReviewer(status: Partial<ReviewerStatus>): void {
    Object.assign(this.reviewer, status);
  }

  getReviewerStatus(): ReviewerStatus {
    return this.reviewer;
  }

  getDb(): Database | null {
    return this.db;
  }

  isPaused(): boolean {
    return this.paused;
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  incrementIssueFailures(issueId: string): number {
    const count = (this.issueFailureCount.get(issueId) ?? 0) + 1;
    this.issueFailureCount.set(issueId, count);
    if (this.issueFailureCount.size > MAX_FAILURE_ENTRIES) {
      const oldestKey = this.issueFailureCount.keys().next().value;
      if (oldestKey !== undefined) {
        this.issueFailureCount.delete(oldestKey);
      }
    }
    return count;
  }

  getIssueFailureCount(issueId: string): number {
    return this.issueFailureCount.get(issueId) ?? 0;
  }

  clearIssueFailures(issueId: string): void {
    this.issueFailureCount.delete(issueId);
  }

  addSpend(costUsd: number): void {
    this.spendLog.push({ timestampMs: Date.now(), costUsd });
    // Evict entries older than 32 days to prevent unbounded growth
    const cutoff = Date.now() - 32 * 24 * 60 * 60 * 1000;
    this.spendLog = this.spendLog.filter((e) => e.timestampMs >= cutoff);
  }

  getDailySpend(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.spendLog
      .filter((e) => e.timestampMs >= cutoff)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  getMonthlySpend(): number {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return this.spendLog
      .filter((e) => e.timestampMs >= monthStart)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  checkBudget(config: AutopilotConfig): { ok: boolean; reason?: string } {
    const { daily_limit_usd, monthly_limit_usd } = config.budget;
    if (daily_limit_usd > 0) {
      const daily = this.getDailySpend();
      if (daily >= daily_limit_usd) {
        return {
          ok: false,
          reason: `Daily budget $${daily.toFixed(2)} of $${daily_limit_usd.toFixed(2)} exhausted`,
        };
      }
    }
    if (monthly_limit_usd > 0) {
      const monthly = this.getMonthlySpend();
      if (monthly >= monthly_limit_usd) {
        return {
          ok: false,
          reason: `Monthly budget $${monthly.toFixed(2)} of $${monthly_limit_usd.toFixed(2)} exhausted`,
        };
      }
    }
    return { ok: true };
  }

  getBudgetWarning(config: AutopilotConfig): string | null {
    const { daily_limit_usd, monthly_limit_usd, warn_at_percent } =
      config.budget;
    const threshold = warn_at_percent / 100;
    if (daily_limit_usd > 0) {
      const daily = this.getDailySpend();
      if (daily >= daily_limit_usd * threshold && daily < daily_limit_usd) {
        return `Daily spend $${daily.toFixed(2)} is ${Math.round((daily / daily_limit_usd) * 100)}% of $${daily_limit_usd.toFixed(2)} limit`;
      }
    }
    if (monthly_limit_usd > 0) {
      const monthly = this.getMonthlySpend();
      if (
        monthly >= monthly_limit_usd * threshold &&
        monthly < monthly_limit_usd
      ) {
        return `Monthly spend $${monthly.toFixed(2)} is ${Math.round((monthly / monthly_limit_usd) * 100)}% of $${monthly_limit_usd.toFixed(2)} limit`;
      }
    }
    return null;
  }

  getBudgetSnapshot(config: AutopilotConfig): {
    dailySpend: number;
    monthlySpend: number;
    dailyLimit: number;
    monthlyLimit: number;
    perAgentLimit: number;
    warnAtPercent: number;
    warning: string | null;
    exhausted: boolean;
    reason?: string;
  } {
    const {
      daily_limit_usd,
      monthly_limit_usd,
      per_agent_limit_usd,
      warn_at_percent,
    } = config.budget;
    const budgetCheck = this.checkBudget(config);
    return {
      dailySpend: this.getDailySpend(),
      monthlySpend: this.getMonthlySpend(),
      dailyLimit: daily_limit_usd,
      monthlyLimit: monthly_limit_usd,
      perAgentLimit: per_agent_limit_usd,
      warnAtPercent: warn_at_percent,
      warning: this.getBudgetWarning(config),
      exhausted: !budgetCheck.ok,
      ...(budgetCheck.reason ? { reason: budgetCheck.reason } : {}),
    };
  }

  toJSON(): AppStateSnapshot {
    return {
      paused: this.paused,
      agents: this.getRunningAgents(),
      history: this.history,
      queue: this.queue,
      planning: this.planning,
      reviewer: this.reviewer,
      startedAt: this.startedAt,
      apiHealth: defaultRegistry.getAllStates(),
    };
  }
}
