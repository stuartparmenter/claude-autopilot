import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { countIssuesInState } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { AUTOPILOT_ROOT, buildCTOPrompt } from "./lib/prompt";
import type { AppState } from "./state";

const DEFAULT_PLANNING_TIMEOUT_MINUTES = 90;

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

  const [readyCount, triageCount] = await Promise.all([
    countIssuesInState(linearIds, linearIds.states.ready),
    countIssuesInState(linearIds, linearIds.states.triage),
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
      LINEAR_PROJECT: config.linear.project,
      MAX_ISSUES_PER_RUN: String(config.planning.max_issues_per_run),
      PROJECT_NAME: config.project.name,
    };

    const prompt = buildCTOPrompt(vars);
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
      timeoutMs:
        (config.planning.timeout_minutes ?? DEFAULT_PLANNING_TIMEOUT_MINUTES) *
        60 *
        1000,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
      model: config.executor.planning_model,
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
