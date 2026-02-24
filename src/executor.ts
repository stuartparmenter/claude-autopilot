import { runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getReadyIssues, updateIssue } from "./lib/linear";
import { info, ok, warn } from "./lib/logger";
import { buildPrompt } from "./lib/prompt";
import type { AppState } from "./state";

/**
 * Execute a single Linear issue using a Claude agent.
 * Returns a promise that resolves when the agent finishes.
 */
export async function executeIssue(opts: {
  issue: { id: string; identifier: string; title: string };
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
}): Promise<boolean> {
  const { issue, config, projectPath, linearIds, state } = opts;
  const agentId = `exec-${issue.identifier}-${Date.now()}`;

  info(`Executing: ${issue.identifier} — ${issue.title}`);
  state.addAgent(agentId, issue.identifier, issue.title);

  const prompt = buildPrompt("executor", {
    ISSUE_ID: issue.identifier,
    DONE_STATE: config.linear.states.done,
    BLOCKED_STATE: config.linear.states.blocked,
    PROJECT_NAME: config.project.name,
  });

  const worktree = `autopilot/${issue.identifier}`;
  const timeoutMs = config.executor.timeout_minutes * 60 * 1000;

  const result = await runClaude({
    prompt,
    cwd: projectPath,
    worktree,
    timeoutMs,
    model: config.executor.model,
    onActivity: (entry) => state.addActivity(agentId, entry),
  });

  if (result.timedOut) {
    warn(
      `${issue.identifier} timed out after ${config.executor.timeout_minutes} minutes`,
    );
    await updateIssue(issue.id, {
      stateId: linearIds.states.blocked,
      comment: `Executor timed out after ${config.executor.timeout_minutes} minutes.\n\nThe implementation may be partially complete. Check the \`${worktree}\` branch for any progress.`,
    });
    state.completeAgent(agentId, "timed_out", {
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      error: "Timed out",
    });
    return false;
  }

  if (result.error) {
    warn(`${issue.identifier} failed: ${result.error}`);
    state.completeAgent(agentId, "failed", {
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      error: result.error,
    });
    return false;
  }

  ok(`${issue.identifier} completed successfully`);
  if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
  state.completeAgent(agentId, "completed", {
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
  });
  return true;
}

/**
 * Fill available executor slots by starting agents for ready issues.
 * Returns an array of promises (one per started agent).
 */
export async function fillSlots(opts: {
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
}): Promise<Array<Promise<boolean>>> {
  const { config, projectPath, linearIds, state } = opts;
  const maxSlots = config.executor.parallel;
  const running = state.getRunningCount();
  const available = maxSlots - running;

  if (available <= 0) {
    return [];
  }

  info(`Querying Linear for ready issues (${available} slots available)...`);

  const issues = await getReadyIssues(linearIds, available);

  state.updateQueue(issues.length, running);

  if (issues.length === 0) {
    info("No ready unblocked issues found");
    return [];
  }

  info(`Starting ${issues.length} executor agent(s)...`);

  return issues.map((issue) =>
    executeIssue({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      },
      config,
      projectPath,
      linearIds,
      state,
    }),
  );
}
