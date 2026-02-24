import { runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getReadyIssues, updateIssue } from "./lib/linear";
import { info, ok, warn } from "./lib/logger";
import { buildPrompt } from "./lib/prompt";
import type { AppState } from "./state";

// Track issue IDs currently being worked on to prevent duplicates
const activeIssueIds = new Set<string>();

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
  shutdownSignal?: AbortSignal;
}): Promise<boolean> {
  const { issue, config, projectPath, linearIds, state } = opts;
  const agentId = `exec-${issue.identifier}-${Date.now()}`;

  info(`Executing: ${issue.identifier} - ${issue.title}`);
  state.addAgent(agentId, issue.identifier, issue.title);
  activeIssueIds.add(issue.id);

  // Move to In Progress immediately so it's not picked up again
  await updateIssue(issue.id, { stateId: linearIds.states.in_progress });

  const prompt = buildPrompt("executor", {
    ISSUE_ID: issue.identifier,
    IN_REVIEW_STATE: config.linear.states.in_review,
    BLOCKED_STATE: config.linear.states.blocked,
    PROJECT_NAME: config.project.name,
    AUTOMERGE_INSTRUCTION: config.github.automerge
      ? "Enable auto-merge on the PR using the GitHub MCP. Do not specify a merge method — the repository's default merge strategy will be used. If enabling auto-merge fails (e.g., the repository does not have auto-merge enabled, or branch protection rules are not configured), note the failure in your Linear comment but do NOT treat it as a blocking error."
      : "Skip — auto-merge is not enabled for this project.",
  });

  const worktree = issue.identifier;
  const timeoutMs = config.executor.timeout_minutes * 60 * 1000;

  try {
    const result = await runClaude({
      prompt,
      cwd: projectPath,
      worktree,
      timeoutMs,
      model: config.executor.model,
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {
            Authorization: `Bearer ${process.env.LINEAR_API_KEY}`,
          },
        },
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          },
        },
      },
      parentSignal: opts.shutdownSignal,
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    if (result.timedOut) {
      warn(
        `${issue.identifier} timed out after ${config.executor.timeout_minutes} minutes`,
      );
      await updateIssue(issue.id, {
        stateId: linearIds.states.blocked,
        comment: `Executor timed out after ${config.executor.timeout_minutes} minutes.\n\nThe implementation may be partially complete. Check the \`worktree-${worktree}\` branch for any progress.`,
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
      // Move back to Ready so it can be retried on next loop
      await updateIssue(issue.id, { stateId: linearIds.states.ready });
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
  } finally {
    activeIssueIds.delete(issue.id);
  }
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
  shutdownSignal?: AbortSignal;
}): Promise<Array<Promise<boolean>>> {
  const { config, projectPath, linearIds, state } = opts;
  const maxSlots = config.executor.parallel;
  const running = state.getRunningCount();
  const available = maxSlots - running;

  if (available <= 0) {
    return [];
  }

  info(`Querying Linear for ready issues (${available} slots available)...`);

  const allReady = await getReadyIssues(
    linearIds,
    available + activeIssueIds.size,
  );
  const issues = allReady.filter((i) => !activeIssueIds.has(i.id));

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
      shutdownSignal: opts.shutdownSignal,
    }),
  );
}
