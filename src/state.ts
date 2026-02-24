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
  error?: string;
}

export interface QueueInfo {
  readyCount: number;
  inProgressCount: number;
  lastChecked: number;
}

export interface AuditorStatus {
  running: boolean;
  lastRunAt?: number;
  lastResult?: "completed" | "skipped" | "failed" | "timed_out";
  readyCount?: number;
  threshold?: number;
}

export interface AppStateSnapshot {
  paused: boolean;
  agents: AgentState[];
  history: AgentResult[];
  queue: QueueInfo;
  auditor: AuditorStatus;
  startedAt: number;
}

const MAX_HISTORY = 50;
const MAX_ACTIVITIES_PER_AGENT = 200;

export class AppState {
  private agents = new Map<string, AgentState>();
  private history: AgentResult[] = [];
  private controllers = new Map<string, AbortController>();
  private queue: QueueInfo = {
    readyCount: 0,
    inProgressCount: 0,
    lastChecked: 0,
  };
  private auditor: AuditorStatus = { running: false };
  private paused = false;
  private issueFailureCount = new Map<string, number>();
  readonly startedAt = Date.now();

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
      error?: string;
    },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = status;
    if (meta) Object.assign(agent, meta);

    this.history.unshift({
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
      error: agent.error,
    });

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

  updateAuditor(status: Partial<AuditorStatus>): void {
    Object.assign(this.auditor, status);
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

  getHistory(): AgentResult[] {
    return this.history;
  }

  getAuditorStatus(): AuditorStatus {
    return this.auditor;
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
    return count;
  }

  getIssueFailureCount(issueId: string): number {
    return this.issueFailureCount.get(issueId) ?? 0;
  }

  toJSON(): AppStateSnapshot {
    return {
      paused: this.paused,
      agents: this.getRunningAgents(),
      history: this.history,
      queue: this.queue,
      auditor: this.auditor,
      startedAt: this.startedAt,
    };
  }
}
