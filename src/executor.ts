import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getReadyIssues, updateIssue, validateIdentifier } from "./lib/linear";
import { info } from "./lib/logger";
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
  validateIdentifier(issue.identifier);
  const agentId = `exec-${issue.identifier}-${Date.now()}`;

  info(`Executing: ${issue.identifier} - ${issue.title}`);
  state.addAgent(agentId, issue.identifier, issue.title, issue.id);
  activeIssueIds.add(issue.id);

  // Move to In Progress immediately so it's not picked up again
  await updateIssue(issue.id, { stateId: linearIds.states.in_progress });

  const prompt = buildPrompt("executor", {
    ISSUE_ID: issue.identifier,
    IN_REVIEW_STATE: config.linear.states.in_review,
    BLOCKED_STATE: config.linear.states.blocked,
    PROJECT_NAME: config.project.name,
    AUTOMERGE_INSTRUCTION: config.github.automerge
      ? "Enable auto-merge on the PR using the `enable_auto_merge` tool from the `autopilot` MCP server. If enabling auto-merge fails (e.g., the repository does not have auto-merge enabled, or branch protection rules are not configured), note the failure in your Linear comment but do NOT treat it as a blocking error."
      : "Skip — auto-merge is not enabled for this project.",
  });

  const worktree = issue.identifier;
  const timeoutMs = config.executor.timeout_minutes * 60 * 1000;

  try {
    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: issue.identifier,
      worktree,
      timeoutMs,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
      model: config.executor.model,
      sandbox: config.sandbox,
      mcpServers: buildMcpServers(),
      parentSignal: opts.shutdownSignal,
      onControllerReady: (ctrl) => state.registerAgentController(agentId, ctrl),
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    const { status } = handleAgentResult(
      result,
      state,
      agentId,
      issue.identifier,
    );

    if (status === "timed_out") {
      if (result.inactivityTimedOut) {
        await updateIssue(issue.id, { stateId: linearIds.states.ready });
      } else {
        await updateIssue(issue.id, {
          stateId: linearIds.states.blocked,
          comment: `Executor timed out after ${config.executor.timeout_minutes} minutes.\n\nThe implementation may be partially complete. Check the \`worktree-${worktree}\` branch for any progress.`,
        });
      }
      return false;
    }

    if (status === "failed") {
      const failureCount = state.incrementIssueFailures(issue.id);
      if (failureCount >= config.executor.max_retries) {
        await updateIssue(issue.id, {
          stateId: linearIds.states.blocked,
          comment: `Executor failed after ${failureCount} total attempt(s) — moving to Blocked.\n\nLast error:\n\`\`\`\n${result.error}\n\`\`\``,
        });
        state.clearIssueFailures(issue.id);
      } else {
        // Move back to Ready so it can be retried on next loop
        await updateIssue(issue.id, { stateId: linearIds.states.ready });
      }
      return false;
    }

    state.clearIssueFailures(issue.id);
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
  if (opts.shutdownSignal?.aborted) return [];

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
