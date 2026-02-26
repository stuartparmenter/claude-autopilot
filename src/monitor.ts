import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getPRStatus } from "./lib/github";
import { getLinearClient } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { buildPrompt } from "./lib/prompt";
import { withRetry } from "./lib/retry";
import type { AppState } from "./state";

// Track issue IDs with active fixers to prevent duplicates
const activeFixerIssues = new Set<string>();

// Track fixer attempt counts per PR number to enforce max_fixer_attempts
const fixerAttempts = new Map<number, number>();
const MAX_FIXER_ATTEMPT_ENTRIES = 1000;

/**
 * Check issues in "In Review" and take action based on their PR status.
 * Starts from Linear (source of truth), then checks GitHub.
 * Returns an array of fixer promises (one per spawned fixer agent).
 */
export async function checkOpenPRs(opts: {
  owner: string;
  repo: string;
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<Array<Promise<boolean>>> {
  const { owner, repo, config, linearIds, state } = opts;
  const maxSlots = config.executor.parallel;

  const budgetCheck = state.checkBudget(config);
  if (!budgetCheck.ok) {
    warn(`Budget limit reached: ${budgetCheck.reason}`);
    if (!state.isPaused()) {
      state.togglePause();
    }
    return [];
  }

  // Query Linear for issues in "In Review" state
  const client = getLinearClient();
  const result = await withRetry(
    () =>
      client.issues({
        filter: {
          team: { id: { eq: linearIds.teamId } },
          state: { id: { eq: linearIds.states.in_review } },
          project: { id: { eq: linearIds.projectId } },
        },
        first: 50,
      }),
    "checkOpenPRs",
  );

  const issues = result.nodes;
  if (issues.length === 0) {
    // No issues in review — prune all stale fixer attempt entries
    fixerAttempts.clear();
    return [];
  }

  info(`Monitoring ${issues.length} issue(s) in review...`);

  // First pass: collect PR numbers from all issues (for pruning stale entries)
  interface IssueData {
    issue: (typeof issues)[number];
    prNumber: number;
  }

  const allIssueData: IssueData[] = [];
  for (const issue of issues) {
    let attachments: Awaited<ReturnType<(typeof issue)["attachments"]>>;
    try {
      attachments = await issue.attachments();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Failed to get attachments for ${issue.identifier}: ${msg}`);
      continue;
    }
    const ghAttachment = attachments.nodes.find(
      (a) => a.sourceType === "github",
    );
    if (!ghAttachment?.url) {
      continue; // No PR linked yet — executor may still be pushing
    }

    const prMatch = ghAttachment.url.match(/\/pull\/(\d+)/);
    if (!prMatch) {
      warn(
        `Could not parse PR number from attachment URL: ${ghAttachment.url}`,
      );
      continue;
    }
    const prNumber = Number.parseInt(prMatch[1], 10);
    allIssueData.push({ issue, prNumber });
  }

  // Prune fixer attempt entries for PRs no longer in "In Review"
  const activePrNumbers = new Set(allIssueData.map((d) => d.prNumber));
  for (const prNumber of fixerAttempts.keys()) {
    if (!activePrNumbers.has(prNumber)) {
      fixerAttempts.delete(prNumber);
    }
  }

  // Second pass: slot-limited fixer spawning
  const fixerPromises: Array<Promise<boolean>> = [];

  for (const { issue, prNumber } of allIssueData) {
    // Skip issues that already have an active fixer
    if (activeFixerIssues.has(issue.id)) {
      continue;
    }

    // Check slot availability (fixers count against executor.parallel)
    const running = state.getRunningCount();
    if (running + fixerPromises.length >= maxSlots) {
      info("No slots available for fixers — skipping remaining issues");
      break;
    }

    // Check fixer attempt budget
    const attempts = fixerAttempts.get(prNumber) ?? 0;
    if (attempts >= config.executor.max_fixer_attempts) {
      warn(
        `PR #${prNumber} (${issue.identifier}) has reached max fixer attempts (${config.executor.max_fixer_attempts}) — skipping`,
      );
      continue;
    }

    let status: Awaited<ReturnType<typeof getPRStatus>>;
    try {
      status = await getPRStatus(owner, repo, prNumber);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Failed to get status for PR #${prNumber}: ${msg}`);
      continue;
    }

    // Merged PRs are handled by the Linear/GitHub webhook, not here

    if (status.ciStatus === "failure") {
      fixerAttempts.set(prNumber, attempts + 1);
      if (fixerAttempts.size > MAX_FIXER_ATTEMPT_ENTRIES) {
        const oldestKey = fixerAttempts.keys().next().value;
        if (oldestKey !== undefined) {
          fixerAttempts.delete(oldestKey);
        }
      }
      const promise = fixPR({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        prNumber,
        branch: status.branch,
        failureType: "ci_failure",
        ...opts,
      });
      fixerPromises.push(promise);
      continue;
    }

    if (status.mergeable === false) {
      fixerAttempts.set(prNumber, attempts + 1);
      if (fixerAttempts.size > MAX_FIXER_ATTEMPT_ENTRIES) {
        const oldestKey = fixerAttempts.keys().next().value;
        if (oldestKey !== undefined) {
          fixerAttempts.delete(oldestKey);
        }
      }
      const promise = fixPR({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        prNumber,
        branch: status.branch,
        failureType: "merge_conflict",
        ...opts,
      });
      fixerPromises.push(promise);
    }

    // CI pending or passing+mergeable — skip
  }

  return fixerPromises;
}

/**
 * Spawn a fixer agent to fix a failing PR.
 */
async function fixPR(opts: {
  issueId: string;
  issueIdentifier: string;
  prNumber: number;
  branch: string;
  failureType: "ci_failure" | "merge_conflict";
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<boolean> {
  const {
    issueId,
    issueIdentifier,
    prNumber,
    branch,
    failureType,
    config,
    projectPath,
    state,
  } = opts;
  const agentId = `fix-${issueIdentifier}-${Date.now()}`;

  info(`Fixing PR #${prNumber} (${issueIdentifier}): ${failureType}`);
  state.addAgent(
    agentId,
    issueIdentifier,
    `Fix ${failureType} on ${issueIdentifier}`,
  );
  activeFixerIssues.add(issueId);

  const prompt = buildPrompt("fixer", {
    ISSUE_ID: issueIdentifier,
    BRANCH: branch,
    FAILURE_TYPE: failureType,
    PR_NUMBER: String(prNumber),
    PROJECT_NAME: config.project.name,
    IN_REVIEW_STATE: config.linear.states.in_review,
    BLOCKED_STATE: config.linear.states.blocked,
  });

  const worktree = `fix-${issueIdentifier}`;
  const timeoutMs = config.executor.fixer_timeout_minutes * 60 * 1000;

  try {
    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: `fix-${issueIdentifier}`,
      worktree,
      worktreeBranch: branch,
      timeoutMs,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
      model: config.executor.model,
      sandbox: config.sandbox,
      mcpServers: buildMcpServers(),
      parentSignal: opts.shutdownSignal,
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    const { status } = handleAgentResult(
      result,
      state,
      agentId,
      `Fixer for ${issueIdentifier}`,
    );
    return status === "completed";
  } finally {
    activeFixerIssues.delete(issueId);
  }
}
