import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { handleAgentResult } from "./lib/agent-result";
import { buildMcpServers, runClaude } from "./lib/claude";
import type { AutopilotConfig, LinearIds } from "./lib/config";
import { getLinearClient } from "./lib/linear";
import { info, warn } from "./lib/logger";
import { AUTOPILOT_ROOT } from "./lib/prompt";
import { withRetry } from "./lib/retry";
import type { AppState } from "./state";

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
  const available = config.executor.parallel - running;
  const maxOwners = Math.min(
    activeProjects.length,
    config.projects.max_active_projects,
    Math.max(0, available),
  );

  if (maxOwners <= 0) return [];

  const promises: Array<Promise<boolean>> = [];

  for (const project of activeProjects.slice(0, maxOwners)) {
    // Count triage issues for this project
    const triageIssues = await withRetry(
      () =>
        project.issues({
          filter: { state: { id: { eq: linearIds.states.triage } } },
        }),
      "checkProjects",
    );

    if (triageIssues.nodes.length === 0) continue;

    info(
      `Project "${project.name}" has ${triageIssues.nodes.length} triage issue(s), spawning owner`,
    );

    const triageList = triageIssues.nodes
      .map((i) => `- ${i.identifier}: ${i.title}`)
      .join("\n");

    // Register agent eagerly so getRunningCount() is accurate for slot checks
    const agentId = `project-owner-${project.name}-${Date.now()}`;
    state.addAgent(
      agentId,
      `project:${project.name}`,
      `Owning ${project.name}`,
    );

    promises.push(
      runProjectOwner({
        agentId,
        projectName: project.name,
        projectId: project.id,
        triageList,
        ...opts,
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
    config,
    linearIds,
    state,
  } = opts;

  const prompt = `You are the project owner for "${projectName}".

Project Name: ${projectName}
Project ID: ${projectId}
Linear Team: ${config.linear.team}
Initiative: ${linearIds.initiativeName || "N/A"}

## Workflow State Names

Use these exact state names when moving issues:
- **Ready state**: "${config.linear.states.ready}" (accepted issues go here)
- **Backlog/Deferred state**: "${config.linear.states.blocked}" (deferred issues go here)
- **Triage state**: "${config.linear.states.triage}" (current state of incoming issues)

IMPORTANT: When calling save_status_update or save_project, always use the Project ID ("${projectId}"), NOT the project name. The project name may collide with the initiative name.

## Triage Queue

${triageList}

Review each triage issue, accept or defer, spawn technical planners for accepted issues that need decomposition, assess project health, and post a status update.`;

  const plugins: SdkPluginConfig[] = [
    {
      type: "local",
      path: resolve(AUTOPILOT_ROOT, "plugins/planning-skills"),
    },
  ];

  try {
    const result = await runClaude({
      prompt,
      cwd: opts.projectPath,
      label: `project-owner:${projectName}`,
      timeoutMs: config.projects.timeout_minutes * 60 * 1000,
      inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
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
  }
}
