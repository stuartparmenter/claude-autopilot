import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { countIssuesInState } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { AUTOPILOT_ROOT, buildPrompt } from "./lib/prompt";
import type { AppState } from "./state";

/**
 * Check whether the planning agent should run based on the backlog threshold.
 */
export async function shouldRunPlanning(opts: {
  config: AutopilotConfig;
  linearIds: LinearIds;
  state: AppState;
}): Promise<boolean> {
  const { config, linearIds, state } = opts;

  if (config.planning.schedule === "manual") {
    return false;
  }

  const lastRunAt = state.getPlanningStatus().lastRunAt;
  if (lastRunAt !== undefined) {
    const elapsedMs = Date.now() - lastRunAt;
    const intervalMs = config.planning.min_interval_minutes * 60 * 1000;
    if (elapsedMs < intervalMs) {
      return false;
    }
  }

  const filters = {
    labels: config.linear.labels,
    projects: config.linear.projects,
  };
  const [readyCount, triageCount] = await Promise.all([
    countIssuesInState(linearIds, linearIds.states.ready, filters),
    countIssuesInState(linearIds, linearIds.states.triage, filters),
  ]);
  const backlogCount = readyCount + triageCount;

  state.updatePlanning({
    readyCount: backlogCount,
    threshold: config.planning.min_ready_threshold,
  });

  if (backlogCount >= config.planning.min_ready_threshold) {
    info(
      `Backlog sufficient (${readyCount} ready + ${triageCount} triage = ${backlogCount} >= ${config.planning.min_ready_threshold}), skipping planning`,
    );
    return false;
  }

  info(
    `Backlog low (${readyCount} ready + ${triageCount} triage = ${backlogCount} < ${config.planning.min_ready_threshold}), planning recommended`,
  );
  return true;
}

/**
 * Run the planning agent to scan the codebase and file improvement issues.
 */
export async function runPlanning(opts: {
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<void> {
  const { config, projectPath, state } = opts;
  const agentId = `planning-${Date.now()}`;

  state.addAgent(agentId, "planning", "Codebase planning");
  state.updatePlanning({ running: true });

  try {
    info("Starting planning agent...");

    const vars = {
      LINEAR_TEAM: config.linear.team,
      MAX_ISSUES_PER_RUN: String(config.planning.max_issues_per_run),
      REPO_NAME: projectPath.split("/").pop() || "unknown",
      INITIATIVE_NAME: opts.linearIds.initiativeName || "Not configured",
      INITIATIVE_ID: opts.linearIds.initiativeId || "",
      TRIAGE_STATE: config.linear.states.triage,
      READY_STATE: config.linear.states.ready,
      TODAY: new Date().toISOString().slice(0, 10),
    };

    const prompt = buildPrompt("cto", vars, projectPath);
    const plugins: SdkPluginConfig[] = [
      {
        type: "local",
        path: resolve(AUTOPILOT_ROOT, "plugins/planning-skills"),
      },
    ];

    const result = await runClaude({
      prompt,
      cwd: projectPath,
      label: "planning",
      timeoutMs: config.planning.timeout_minutes * 60 * 1000,
      inactivityMs: config.planning.inactivity_timeout_minutes * 60 * 1000,
      model: config.planning.model,
      sandbox: config.sandbox,
      mcpServers: buildMcpServers(),
      plugins,
      parentSignal: opts.shutdownSignal,
      onControllerReady: (ctrl) => state.registerAgentController(agentId, ctrl),
      onActivity: (entry) => state.addActivity(agentId, entry),
    });

    const { status } = handleAgentResult(result, state, agentId, "Planning");
    state.updatePlanning({
      running: false,
      lastRunAt: Date.now(),
      lastResult: status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Planning agent crashed: ${msg}`);
    state.completeAgent(agentId, "failed", { error: msg });
    state.updatePlanning({
      running: false,
      lastRunAt: Date.now(),
      lastResult: "failed",
    });
  }
}
