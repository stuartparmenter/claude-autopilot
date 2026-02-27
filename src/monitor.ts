import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getPRReviewInfo, getPRStatus } from "./lib/github";
import { getLinearClient } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { AUTOPILOT_ROOT, buildPrompt } from "./lib/prompt";
import { withRetry } from "./lib/retry";
import { AUTOPILOT_PREFIX } from "./lib/sandbox-clone";
import type { AppState } from "./state";

// Track issue IDs with active fixers to prevent duplicates
const activeFixerIssues = new Set<string>();

// Track "issueId:reviewId" pairs that have already triggered a review responder.
// Kept across calls so the same review never spawns two responders; a new
// review (different ID) on the same issue will pass through correctly.
const handledReviewIds = new Set<string>();

/**
 * Reset the handled review IDs set. Used in tests to prevent state leakage.
 */
export function resetHandledReviewIds(): void {
  handledReviewIds.clear();
}

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
  const maxSlots = state.getMaxParallel();

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

  // First pass: collect PR numbers from all issues (for pruning stale entries).
  // Fetch attachments in parallel — each issue's lookup is independent.
  interface IssueData {
    issue: (typeof issues)[number];
    prNumber: number;
  }

  const allIssueData: IssueData[] = (
    await Promise.all(
      issues.map(async (issue) => {
        let attachments: Awaited<ReturnType<(typeof issue)["attachments"]>>;
        try {
          attachments = await withRetry(
            () => issue.attachments(),
            `attachments:${issue.identifier}`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn(`Failed to get attachments for ${issue.identifier}: ${msg}`);
          return null;
        }
        const ghAttachment = attachments.nodes.find(
          (a) => a.sourceType === "github",
        );
        if (!ghAttachment?.url) {
          return null; // No PR linked yet — executor may still be pushing
        }

        const prMatch = ghAttachment.url.match(/\/pull\/(\d+)/);
        if (!prMatch) {
          warn(
            `Could not parse PR number from attachment URL: ${ghAttachment.url}`,
          );
          return null;
        }
        const prNumber = Number.parseInt(prMatch[1], 10);
        return { issue, prNumber };
      }),
    )
  ).filter((item): item is IssueData => item !== null);

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

    const failureType =
      status.ciStatus === "failure"
        ? "ci_failure"
        : status.mergeable === false
          ? "merge_conflict"
          : null;

    if (failureType) {
      fixerAttempts.set(prNumber, attempts + 1);
      if (fixerAttempts.size > MAX_FIXER_ATTEMPT_ENTRIES) {
        const oldestKey = fixerAttempts.keys().next().value;
        if (oldestKey !== undefined) {
          fixerAttempts.delete(oldestKey);
        }
      }

      // Register agent in state eagerly so fillSlots sees the correct count
      const agentId = `fix-${issue.identifier}-${Date.now()}`;
      info(`Fixing PR #${prNumber} (${issue.identifier}): ${failureType}`);
      state.addAgent(
        agentId,
        issue.identifier,
        `Fix ${failureType} on ${issue.identifier}`,
      );
      activeFixerIssues.add(issue.id);

      const promise = fixPR({
        agentId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        prNumber,
        branch: status.branch,
        failureType,
        ...opts,
      });
      fixerPromises.push(promise);
      continue;
    }

    // Review responder: only when CI passing (not pending, not failing) and
    // no merge conflict. This runs after the fixer checks so CI failures and
    // merge conflicts always take priority.
    if (config.monitor.respond_to_reviews && status.ciStatus === "success") {
      let reviewInfo: Awaited<ReturnType<typeof getPRReviewInfo>>;
      try {
        reviewInfo = await getPRReviewInfo(owner, repo, prNumber);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`Failed to get review info for PR #${prNumber}: ${msg}`);
        continue;
      }

      if (
        reviewInfo.hasChangesRequested &&
        reviewInfo.latestChangesRequestedReviewId !== null
      ) {
        const dedupKey = `${issue.id}:${reviewInfo.latestChangesRequestedReviewId}`;
        if (!handledReviewIds.has(dedupKey)) {
          handledReviewIds.add(dedupKey);
          const promise = respondToReview({
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            prNumber,
            branch: status.branch,
            reviewComments: reviewInfo.reviewComments,
            reviewSummaries: reviewInfo.reviewSummaries,
            ...opts,
          });
          fixerPromises.push(promise);
        }
      }
    }

    // CI pending or passing+mergeable with no review action — skip
  }

  return fixerPromises;
}

/**
 * Spawn a review-responder agent to address PR review feedback.
 */
async function respondToReview(opts: {
  issueId: string;
  issueIdentifier: string;
  prNumber: number;
  branch: string;
  reviewComments: string;
  reviewSummaries: string;
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<boolean> {
  const {
    issueIdentifier,
    prNumber,
    branch,
    reviewComments,
    reviewSummaries,
    config,
    projectPath,
    state,
  } = opts;
  const agentId = `review-${issueIdentifier}-${Date.now()}`;

  info(`Responding to review on PR #${prNumber} (${issueIdentifier})`);
  state.addAgent(
    agentId,
    issueIdentifier,
    `Respond to review on ${issueIdentifier}`,
  );

  const prompt = buildPrompt("review-responder", {
    ISSUE_ID: issueIdentifier,
    BRANCH: branch,
    PR_NUMBER: String(prNumber),
    PROJECT_NAME: projectPath.split("/").pop() || "unknown",
    REVIEW_COMMENTS: reviewComments,
    REVIEW_SUMMARIES: reviewSummaries,
    IN_REVIEW_STATE: config.linear.states.in_review,
    BLOCKED_STATE: config.linear.states.blocked,
  });

  const cloneName = `${AUTOPILOT_PREFIX}review-${issueIdentifier}`;
  const timeoutMs = config.monitor.review_responder_timeout_minutes * 60 * 1000;
  const plugins: SdkPluginConfig[] = [
    {
      type: "local",
      path: resolve(AUTOPILOT_ROOT, "plugins/git-safety"),
    },
  ];

  const result = await runClaude({
    prompt,
    cwd: projectPath,
    label: `review-${issueIdentifier}`,
    clone: cloneName,
    cloneBranch: branch,
    gitIdentity: {
      userName: config.git.user_name,
      userEmail: config.git.user_email,
    },
    timeoutMs,
    inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
    model: config.executor.model,
    sandbox: config.sandbox,
    mcpServers: buildMcpServers(),
    plugins,
    parentSignal: opts.shutdownSignal,
    onActivity: (entry) => state.addActivity(agentId, entry),
  });

  const { status } = handleAgentResult(
    result,
    state,
    agentId,
    `Review responder for ${issueIdentifier}`,
  );
  return status === "completed";
}

/**
 * Spawn a fixer agent to fix a failing PR.
 */
async function fixPR(opts: {
  agentId: string;
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
    agentId,
    issueId,
    issueIdentifier,
    prNumber,
    branch,
    failureType,
    config,
    projectPath,
    state,
  } = opts;

  const prompt = buildPrompt(
    "fixer",
    {
      ISSUE_ID: issueIdentifier,
      BRANCH: branch,
      FAILURE_TYPE: failureType,
      PR_NUMBER: String(prNumber),
      REPO_NAME: projectPath.split("/").pop() || "unknown",
      IN_REVIEW_STATE: config.linear.states.in_review,
      BLOCKED_STATE: config.linear.states.blocked,
    },
    projectPath,
  );

  const cloneName = `${AUTOPILOT_PREFIX}fix-${issueIdentifier}`;
  const timeoutMs = config.executor.fixer_timeout_minutes * 60 * 1000;
  const plugins: SdkPluginConfig[] = [
    {
      type: "local",
      path: resolve(AUTOPILOT_ROOT, "plugins/git-safety"),
    },
  ];

  try {
    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: `fix-${issueIdentifier}`,
      clone: cloneName,
      cloneBranch: branch,
      gitIdentity: {
        userName: config.git.user_name,
        userEmail: config.git.user_email,
      },
      timeoutMs,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
      model: config.executor.model,
      sandbox: config.sandbox,
      mcpServers: buildMcpServers(),
      plugins,
      parentSignal: opts.shutdownSignal,
      onControllerReady: (ctrl) => state.registerAgentController(agentId, ctrl),
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    const { status } = handleAgentResult(
      result,
      state,
      agentId,
      `Fixer for ${issueIdentifier}`,
    );
    return status === "completed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Fixer agent for ${issueIdentifier} crashed: ${msg}`);
    void state.completeAgent(agentId, "failed", { error: msg });
    return false;
  } finally {
    activeFixerIssues.delete(issueId);
  }
}
