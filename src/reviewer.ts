import type { Database } from "bun:sqlite";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import {
  getRunWithTranscript,
  getUnreviewedRuns,
  markRunsReviewed,
} from "./lib/db";
import { info, warn } from "./lib/logger";
import { buildPrompt } from "./lib/prompt";
import type { AgentResult, AppState } from "./state";

const TRANSCRIPT_EXCERPT_LENGTH = 2000;
const MAX_RUNS_PER_REVIEW = 20;

/**
 * Decide whether the reviewer agent should run based on config, interval, and
 * the number of unreviewed runs in the database.
 */
export async function shouldRunReviewer(opts: {
  config: AutopilotConfig;
  state: AppState;
  db: Database;
}): Promise<boolean> {
  const { config, state, db } = opts;

  if (!config.reviewer.enabled) {
    return false;
  }

  if (state.getReviewerStatus().running) {
    return false;
  }

  const lastRunAt = state.getReviewerStatus().lastRunAt;
  if (lastRunAt !== undefined) {
    const elapsedMs = Date.now() - lastRunAt;
    const intervalMs = config.reviewer.min_interval_minutes * 60 * 1000;
    if (elapsedMs < intervalMs) {
      return false;
    }
  }

  const unreviewedRuns = getUnreviewedRuns(db);
  if (unreviewedRuns.length < config.reviewer.min_runs_before_review) {
    return false;
  }

  return true;
}

/**
 * Spawn the reviewer agent to analyze recent run transcripts and file
 * improvement issues to Linear.
 */
export async function runReviewer(opts: {
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  db: Database;
  shutdownSignal?: AbortSignal;
}): Promise<void> {
  const { config, projectPath, state, db } = opts;
  const agentId = `reviewer-${Date.now()}`;

  state.addAgent(agentId, "reviewer", "Reviewing agent runs");
  state.updateReviewer({ running: true });

  let runIds: string[] = [];

  try {
    info("Starting reviewer agent...");

    const runs = getUnreviewedRuns(db, MAX_RUNS_PER_REVIEW);
    runIds = runs.map((r) => r.id);

    const runSummaries = buildRunSummaries(db, runs);

    const vars = {
      LINEAR_TEAM: config.linear.team,
      TRIAGE_STATE: config.linear.states.triage,
      MAX_ISSUES: String(config.reviewer.max_issues_per_review),
      REPO_NAME: projectPath.split("/").pop() || "unknown",
    };

    const prompt = buildPrompt("reviewer", vars, projectPath, {
      RUN_SUMMARIES: runSummaries,
    });

    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: "reviewer",
      timeoutMs: config.reviewer.timeout_minutes * 60 * 1000,
      inactivityMs: 30 * 60 * 1000,
      model: config.reviewer.model,
      sandbox: config.sandbox,
      mcpServers: buildMcpServers(),
      parentSignal: opts.shutdownSignal,
      onControllerReady: (ctrl) => state.registerAgentController(agentId, ctrl),
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    const { status } = handleAgentResult(result, state, agentId, "Reviewer");

    // Mark runs as reviewed regardless of agent success/failure to avoid
    // reviewing the same runs in a tight loop on repeated failures.
    markRunsReviewed(db, runIds);

    state.updateReviewer({
      running: false,
      lastRunAt: Date.now(),
      lastResult: status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Reviewer agent crashed: ${msg}`);
    state.completeAgent(agentId, "failed", { error: msg });

    // Still mark runs reviewed to prevent a crash loop
    if (runIds.length > 0) {
      markRunsReviewed(db, runIds);
    }

    state.updateReviewer({
      running: false,
      lastRunAt: Date.now(),
      lastResult: "failed",
    });
  }
}

function buildRunSummaries(db: Database, runs: AgentResult[]): string {
  const summaries: string[] = [];

  for (const run of runs) {
    let messagesJson: string | null = null;
    try {
      const result = getRunWithTranscript(db, run.id);
      messagesJson = result.messagesJson;
    } catch {
      // run may not have a transcript if persistence was toggled
    }

    let transcriptExcerpt = "(no transcript available)";
    if (messagesJson) {
      transcriptExcerpt =
        messagesJson.length > TRANSCRIPT_EXCERPT_LENGTH
          ? `...(truncated)...\n${messagesJson.slice(-TRANSCRIPT_EXCERPT_LENGTH)}`
          : messagesJson;
    }

    const durationSec = run.durationMs ? Math.round(run.durationMs / 1000) : 0;
    const costStr = run.costUsd ? `$${run.costUsd.toFixed(4)}` : "unknown";

    summaries.push(
      [
        `--- Run ${run.id} ---`,
        `Issue: ${run.issueId} - ${run.issueTitle}`,
        `Status: ${run.status}`,
        `Cost: ${costStr}`,
        `Duration: ${durationSec}s`,
        `Transcript excerpt:`,
        transcriptExcerpt,
      ].join("\n"),
    );
  }

  return summaries.length > 0
    ? summaries.join("\n\n")
    : "(no unreviewed runs available)";
}
