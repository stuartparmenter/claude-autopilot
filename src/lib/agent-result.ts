import type { AppState } from "../state";
import type { ClaudeResult } from "./claude";
import { info, ok, warn } from "./logger";

export type AgentResultStatus = "completed" | "timed_out" | "failed";

export interface AgentResultHandled {
  status: AgentResultStatus;
  metrics: { costUsd?: number; durationMs?: number; numTurns?: number };
}

/**
 * Classifies a ClaudeResult, calls state.completeAgent(), and logs an outcome message.
 * Returns the status and extracted metrics so callers can handle domain-specific actions
 * (e.g. Linear state updates, auditor status updates).
 */
export function handleAgentResult(
  result: ClaudeResult,
  state: AppState,
  agentId: string,
  label: string,
): AgentResultHandled {
  const metrics = {
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
  };

  if (result.inactivityTimedOut) {
    warn(`${label} inactive, timed out`);
    state.completeAgent(agentId, "timed_out", {
      ...metrics,
      error: "Inactivity timeout",
    });
    return { status: "timed_out", metrics };
  }

  if (result.timedOut) {
    warn(`${label} timed out`);
    state.completeAgent(agentId, "timed_out", {
      ...metrics,
      error: "Timed out",
    });
    return { status: "timed_out", metrics };
  }

  if (result.error) {
    warn(`${label} failed: ${result.error}`);
    state.completeAgent(agentId, "failed", {
      ...metrics,
      error: result.error,
    });
    return { status: "failed", metrics };
  }

  ok(`${label} completed successfully`);
  if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
  state.completeAgent(agentId, "completed", metrics);
  return { status: "completed", metrics };
}
