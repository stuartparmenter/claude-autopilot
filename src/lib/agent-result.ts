import type { AppState } from "../state";
import type { ClaudeResult } from "./claude";
import { info, ok, warn } from "./logger";

export type AgentResultStatus = "completed" | "timed_out" | "failed";

export type ExitReason = "success" | "timeout" | "inactivity" | "error";

export interface AgentResultHandled {
  status: AgentResultStatus;
  metrics: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    sessionId?: string;
  };
}

/**
 * Classifies a ClaudeResult, calls state.completeAgent(), and logs an outcome message.
 * Returns the status and extracted metrics so callers can handle domain-specific actions
 * (e.g. Linear state updates, planning status updates).
 */
export function handleAgentResult(
  result: ClaudeResult,
  state: AppState,
  agentId: string,
  label: string,
  runType?: string,
): AgentResultHandled {
  const metrics: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    sessionId?: string;
  } = {
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
  };
  if (result.sessionId !== undefined) {
    metrics.sessionId = result.sessionId;
  }

  const rawMessages =
    result.rawMessages !== undefined ? result.rawMessages : undefined;

  const withRunType = <T extends object>(base: T): T & { runType?: string } =>
    runType !== undefined ? { ...base, runType } : base;

  if (result.inactivityTimedOut) {
    warn(`${label} inactive, timed out`);
    const meta = withRunType({
      ...metrics,
      error: "Inactivity timeout",
      exitReason: "inactivity" as ExitReason,
    });
    if (rawMessages !== undefined) {
      void state.completeAgent(agentId, "timed_out", meta, rawMessages);
    } else {
      void state.completeAgent(agentId, "timed_out", meta);
    }
    return { status: "timed_out", metrics };
  }

  if (result.timedOut) {
    warn(`${label} timed out`);
    const meta = withRunType({
      ...metrics,
      error: "Timed out",
      exitReason: "timeout" as ExitReason,
    });
    if (rawMessages !== undefined) {
      void state.completeAgent(agentId, "timed_out", meta, rawMessages);
    } else {
      void state.completeAgent(agentId, "timed_out", meta);
    }
    return { status: "timed_out", metrics };
  }

  if (result.error) {
    warn(`${label} failed: ${result.error}`);
    const meta = withRunType({
      ...metrics,
      error: result.error,
      exitReason: "error" as ExitReason,
    });
    if (rawMessages !== undefined) {
      void state.completeAgent(agentId, "failed", meta, rawMessages);
    } else {
      void state.completeAgent(agentId, "failed", meta);
    }
    return { status: "failed", metrics };
  }

  ok(`${label} completed successfully`);
  if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
  const meta = withRunType({ ...metrics, exitReason: "success" as ExitReason });
  if (rawMessages !== undefined) {
    void state.completeAgent(agentId, "completed", meta, rawMessages);
  } else {
    void state.completeAgent(agentId, "completed", meta);
  }
  return { status: "completed", metrics };
}
