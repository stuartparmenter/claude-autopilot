import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getLinearClient } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { AUTOPILOT_ROOT, buildPrompt, sanitizePromptValue } from "./lib/prompt";
import { withRetry } from "./lib/retry";
import type { AppState } from "./state";

// Track project IDs currently being managed to prevent duplicate owners
const activeProjectIds = new Set<string>();

// Track when each project last had its backlog reviewed to prevent tight loops
const lastBacklogReviewAt = new Map<string, number>();

/**
 * Reset the active project IDs set. Used in tests to prevent state leakage.
 */
export function resetActiveProjectIds(): void {
  activeProjectIds.clear();
  lastBacklogReviewAt.clear();
}

/**
 * Check active projects under the initiative for triage issues,
 * and spawn project-owner agents for qualifying projects.
 */
export async function checkProjects(opts: {
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<Array<Promise<boolean>>> {
  const { config, linearIds, state } = opts;

  if (!config.projects.enabled) return [];
  if (!linearIds.initiativeId) return [];

  const budgetCheck = state.checkBudget(config);
  if (!budgetCheck.ok) {
    warn(`Budget limit reached: ${budgetCheck.reason}`);
    if (!state.isPaused()) {
      state.togglePause();
    }
    return [];
  }

  const client = getLinearClient();

  // Fetch the initiative and its projects
  const initiative = await withRetry(
    () => client.initiative(linearIds.initiativeId as string),
    "checkProjects",
  );
  const projectsConnection = await withRetry(
    () => initiative.projects(),
    "checkProjects",
  );

  // Filter to active projects (not completed or canceled)
  const activeProjects = projectsConnection.nodes.filter(
    (p) => p.state !== "completed" && p.state !== "canceled",
  );

  if (activeProjects.length === 0) {
    info("No active projects under initiative");
    return [];
  }

  // Determine how many project owners we can spawn
  const running = state.getRunningCount();
  const available = state.getMaxParallel() - running;
  const maxOwners = Math.min(
    activeProjects.length,
    config.projects.max_active_projects,
    Math.max(0, available),
  );

  if (maxOwners <= 0) return [];

  const promises: Array<Promise<boolean>> = [];

  for (const project of activeProjects.slice(0, maxOwners)) {
    if (activeProjectIds.has(project.id)) continue;

    // Count triage issues for this project
    const triageIssues = await withRetry(
      () =>
        project.issues({
          filter: { state: { id: { eq: linearIds.states.triage } } },
        }),
      "checkProjects",
    );

    const hasTriage = triageIssues.nodes.length > 0;

    // Check if backlog review cooldown has elapsed
    const backlogIntervalMs =
      config.projects.backlog_review_interval_minutes * 60 * 1000;
    const lastReview = lastBacklogReviewAt.get(project.id) ?? 0;
    const backlogCooldownElapsed = Date.now() - lastReview >= backlogIntervalMs;

    // Count backlog issues only if cooldown has elapsed and no triage issues
    let hasBacklog = false;
    if (!hasTriage && backlogCooldownElapsed) {
      const backlogIssues = await withRetry(
        () =>
          project.issues({
            filter: { state: { id: { eq: linearIds.states.blocked } } },
          }),
        "checkProjects",
      );
      hasBacklog = backlogIssues.nodes.length > 0;
    }

    if (!hasTriage && !hasBacklog) continue;

    const reason = hasTriage
      ? `${triageIssues.nodes.length} triage issue(s)`
      : "backlog review (cooldown elapsed)";
    info(`Project "${project.name}" has ${reason}, spawning owner`);

    const triageList = hasTriage
      ? triageIssues.nodes
          .map((i) => `- ${i.identifier}: ${sanitizePromptValue(i.title)}`)
          .join("\n")
      : "No new triage issues.";

    // Register agent eagerly so getRunningCount() is accurate for slot checks
    const agentId = `project-owner-${project.name}-${Date.now()}`;
    state.addAgent(
      agentId,
      `project:${project.name}`,
      `Owning ${project.name}`,
    );

    const includeBacklogReview = hasTriage ? backlogCooldownElapsed : true;

    promises.push(
      runProjectOwner({
        agentId,
        projectName: project.name,
        projectId: project.id,
        triageList,
        includeBacklogReview,
        ...opts,
      }).then((result) => {
        if (includeBacklogReview) {
          lastBacklogReviewAt.set(project.id, Date.now());
        }
        return result;
      }),
    );
  }

  return promises;
}

async function runProjectOwner(opts: {
  agentId: string;
  projectName: string;
  projectId: string;
  triageList: string;
  includeBacklogReview: boolean;
  config: AutopilotConfig;
  projectPath: string;
  linearIds: LinearIds;
  state: AppState;
  shutdownSignal?: AbortSignal;
}): Promise<boolean> {
  const {
    agentId,
    projectName,
    projectId,
    triageList,
    includeBacklogReview,
    config,
    linearIds,
    state,
  } = opts;

  const prompt = buildPrompt(
    "project-owner",
    {
      PROJECT_NAME: projectName,
      PROJECT_ID: projectId,
      LINEAR_TEAM: config.linear.team,
      INITIATIVE_NAME: linearIds.initiativeName || "N/A",
      READY_STATE: config.linear.states.ready,
      BLOCKED_STATE: config.linear.states.blocked,
      TRIAGE_STATE: config.linear.states.triage,
    },
    opts.projectPath,
    {
      TRIAGE_LIST: triageList,
      BACKLOG_REVIEW: includeBacklogReview
        ? `After triaging, review the project's backlog. Use the Linear MCP to list issues in the "${config.linear.states.blocked}" state for this project. For each backlog issue, check if the conditions for deferral have changed (e.g., blocking issues are now Done, circumstances have evolved). If an issue is ready to be reconsidered, move it to the "${config.linear.states.triage}" state so it gets full triage on the next run. Leave issues that are still appropriately deferred.`
        : "Skip backlog review this run (cooldown not elapsed).",
    },
  );

  const plugins: SdkPluginConfig[] = [
    {
      type: "local",
      path: resolve(AUTOPILOT_ROOT, "plugins/planning-skills"),
    },
  ];

  activeProjectIds.add(projectId);
  try {
    const result = await runClaude({
      prompt,
      cwd: opts.projectPath,
      label: `project-owner:${projectName}`,
      timeoutMs: config.projects.timeout_minutes * 60 * 1000,
      inactivityMs: config.planning.inactivity_timeout_minutes * 60 * 1000,
      model: config.projects.model,
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
      `project-owner:${projectName}`,
    );

    return status === "completed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Project owner for "${projectName}" crashed: ${msg}`);
    state.completeAgent(agentId, "failed", { error: msg });
    return false;
  } finally {
    activeProjectIds.delete(projectId);
  }
}
