import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { countIssuesInState } from "./lib/linear";
import { info, ok, warn } from "./lib/logger";
import { buildAuditorPrompt } from "./lib/prompt";
import type { AppState } from "./state";

const AUDITOR_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Check whether the auditor should run based on the backlog threshold.
 */
export async function shouldRunAudit(opts: {
  config: AutopilotConfig;
  linearIds: LinearIds;
  state: AppState;
}): Promise<boolean> {
  const { config, linearIds, state } = opts;

  if (config.auditor.schedule === "manual") {
    return false;
  }

  const [readyCount, triageCount] = await Promise.all([
    countIssuesInState(linearIds, linearIds.states.ready),
    countIssuesInState(linearIds, linearIds.states.triage),
  ]);
  const backlogCount = readyCount + triageCount;

  state.updateAuditor({
    readyCount: backlogCount,
    threshold: config.auditor.min_ready_threshold,
  });

  if (backlogCount >= config.auditor.min_ready_threshold) {
    info(
      `Backlog sufficient (${readyCount} ready + ${triageCount} triage = ${backlogCount} >= ${config.auditor.min_ready_threshold}), skipping audit`,
    );
    return false;
  }

  info(
    `Backlog low (${readyCount} ready + ${triageCount} triage = ${backlogCount} < ${config.auditor.min_ready_threshold}), audit recommended`,
  );
  return true;
}

/**
 * Run the auditor agent to scan the codebase and file improvement issues.
 */
export async function runAudit(opts: {
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<void> {
  const { config, projectPath, state } = opts;
  const agentId = `audit-${Date.now()}`;

  state.addAgent(agentId, "auditor", "Codebase audit");
  state.updateAuditor({ running: true });

  try {
    info("Starting auditor agent...");

    const targetState = config.auditor.skip_triage
      ? config.linear.states.ready
      : config.linear.states.triage;

    const prompt = buildAuditorPrompt({
      LINEAR_TEAM: config.linear.team,
      LINEAR_PROJECT: config.linear.project,
      TARGET_STATE: targetState,
      MAX_ISSUES_PER_RUN: String(config.auditor.max_issues_per_run),
      PROJECT_NAME: config.project.name,
      BRAINSTORM_FEATURES: String(config.auditor.brainstorm_features),
      BRAINSTORM_DIMENSIONS: config.auditor.brainstorm_dimensions.join(", "),
      MAX_IDEAS_PER_RUN: String(config.auditor.max_ideas_per_run),
      FEATURE_TARGET_STATE: config.linear.states.triage,
    });

    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: "auditor",
      timeoutMs: AUDITOR_TIMEOUT_MS,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
      model: config.executor.planning_model,
      mcpServers: buildMcpServers(),
      parentSignal: opts.shutdownSignal,
      onControllerReady: (ctrl) => state.registerAgentController(agentId, ctrl),
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    if (result.inactivityTimedOut) {
      warn(
        `Auditor inactive for ${config.executor.inactivity_timeout_minutes} minutes, timed out`,
      );
      state.completeAgent(agentId, "timed_out", {
        error: "Inactivity timeout",
      });
      state.updateAuditor({
        running: false,
        lastRunAt: Date.now(),
        lastResult: "timed_out",
      });
      return;
    }

    if (result.timedOut) {
      warn("Auditor timed out after 60 minutes");
      state.completeAgent(agentId, "timed_out", { error: "Timed out" });
      state.updateAuditor({
        running: false,
        lastRunAt: Date.now(),
        lastResult: "timed_out",
      });
      return;
    }

    if (result.error) {
      warn(`Auditor failed: ${result.error}`);
      state.completeAgent(agentId, "failed", { error: result.error });
      state.updateAuditor({
        running: false,
        lastRunAt: Date.now(),
        lastResult: "failed",
      });
      return;
    }

    ok("Auditor completed successfully");
    if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
    state.completeAgent(agentId, "completed", {
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    });
    state.updateAuditor({
      running: false,
      lastRunAt: Date.now(),
      lastResult: "completed",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Auditor crashed: ${msg}`);
    state.completeAgent(agentId, "failed", { error: msg });
    state.updateAuditor({
      running: false,
      lastRunAt: Date.now(),
      lastResult: "failed",
    });
  }
}
