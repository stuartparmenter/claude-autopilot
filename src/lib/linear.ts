import {
  type Issue,
  type IssueLabel,
  LinearClient,
  type Project,
  type Team,
  type WorkflowState,
} from "@linear/sdk";
import type { LinearConfig, LinearIds } from "./config";
import { info, warn } from "./logger";
import { withRetry } from "./retry";

let _client: LinearClient | null = null;

/**
 * Get or create the Linear client. Reads LINEAR_API_KEY from environment.
 */
export function getLinearClient(): LinearClient {
  if (_client) return _client;

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY environment variable is not set.\n" +
        "Create one at: https://linear.app/settings/api\n" +
        "Then: export LINEAR_API_KEY=lin_api_...",
    );
  }

  _client = new LinearClient({ apiKey });
  return _client;
}

/**
 * Find a team by its key (e.g., "ENG").
 */
export async function findTeam(teamKey: string): Promise<Team> {
  const client = getLinearClient();
  const teams = await withRetry(
    () => client.teams({ filter: { key: { eq: teamKey } } }),
    "findTeam",
  );
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team '${teamKey}' not found in Linear`);
  return team;
}

/**
 * Find a project by name.
 */
export async function findProject(projectName: string): Promise<Project> {
  const client = getLinearClient();
  const projects = await withRetry(
    () =>
      client.projects({
        filter: { name: { eq: projectName } },
      }),
    "findProject",
  );
  const project = projects.nodes[0];
  if (!project) throw new Error(`Project '${projectName}' not found in Linear`);
  return project;
}

/**
 * Find a workflow state by name within a team.
 */
export async function findState(
  teamId: string,
  stateName: string,
): Promise<WorkflowState> {
  const client = getLinearClient();
  const states = await withRetry(
    () =>
      client.workflowStates({
        filter: { team: { id: { eq: teamId } }, name: { eq: stateName } },
      }),
    "findState",
  );
  const state = states.nodes[0];
  if (!state) throw new Error(`State '${stateName}' not found for team`);
  return state;
}

/**
 * Find or create a label by name within a team.
 */
export async function findOrCreateLabel(
  teamId: string,
  name: string,
  color?: string,
): Promise<IssueLabel> {
  const client = getLinearClient();
  const labels = await withRetry(
    () =>
      client.issueLabels({
        filter: { team: { id: { eq: teamId } }, name: { eq: name } },
      }),
    "findOrCreateLabel",
  );

  if (labels.nodes[0]) return labels.nodes[0];

  info(`Creating label '${name}'...`);
  const payload = await withRetry(
    () =>
      client.createIssueLabel({
        teamId,
        name,
        color: color ?? "#888888",
      }),
    "findOrCreateLabel",
  );
  const label = await payload.issueLabel;
  if (!label) throw new Error(`Failed to create label '${name}'`);
  return label;
}

/**
 * Get ready, unblocked issues for a team+project, sorted by priority.
 */
export async function getReadyIssues(
  linearIds: LinearIds,
  limit: number = 10,
): Promise<Issue[]> {
  const client = getLinearClient();

  const result = await withRetry(
    () =>
      client.issues({
        filter: {
          team: { id: { eq: linearIds.teamId } },
          state: { id: { eq: linearIds.states.ready } },
          project: { id: { eq: linearIds.projectId } },
        },
        first: limit,
      }),
    "getReadyIssues",
  );

  // Sort by priority (lower number = higher priority in Linear)
  const sorted = [...result.nodes].sort(
    (a, b) => (a.priority ?? 4) - (b.priority ?? 4),
  );

  // Filter out issues that are blocked by incomplete issues
  const unblocked: Issue[] = [];

  for (const issue of sorted) {
    const relations = await withRetry(() => issue.relations(), "getReadyIssues");
    let isBlocked = false;

    for (const relation of relations.nodes) {
      if (relation.type === "blocks") {
        const related = await withRetry(
          async () => relation.relatedIssue,
          "getReadyIssues",
        );
        if (related) {
          const state = await withRetry(
            async () => related.state,
            "getReadyIssues",
          );
          if (
            state &&
            state.type !== "completed" &&
            state.type !== "canceled"
          ) {
            isBlocked = true;
            break;
          }
        }
      }
    }

    if (!isBlocked) {
      unblocked.push(issue);
    }
  }

  return unblocked;
}

/**
 * Count issues in a given state for the configured project.
 */
export async function countIssuesInState(
  linearIds: LinearIds,
  stateId: string,
): Promise<number> {
  const client = getLinearClient();
  let result = await withRetry(
    () =>
      client.issues({
        filter: {
          team: { id: { eq: linearIds.teamId } },
          state: { id: { eq: stateId } },
          project: { id: { eq: linearIds.projectId } },
        },
        first: 250,
      }),
    "countIssuesInState",
  );

  while (result.pageInfo.hasNextPage) {
    result = await result.fetchNext();
  }

  return result.nodes.length;
}

/**
 * Move an issue to a new state and optionally add a comment.
 */
export async function updateIssue(
  issueId: string,
  opts: { stateId?: string; comment?: string },
): Promise<void> {
  const client = getLinearClient();

  if (opts.stateId) {
    await withRetry(
      () => client.updateIssue(issueId, { stateId: opts.stateId }),
      "updateIssue",
    );
  }

  if (opts.comment) {
    await withRetry(
      () => client.createComment({ issueId, body: opts.comment as string }),
      "updateIssue",
    );
  }
}

/**
 * Create an issue in Linear, assigned to the configured project.
 */
export async function createIssue(opts: {
  teamId: string;
  projectId: string;
  title: string;
  description: string;
  stateId: string;
  priority?: number;
  labelIds?: string[];
  parentId?: string;
}): Promise<Issue> {
  const client = getLinearClient();
  const payload = await withRetry(
    () =>
      client.createIssue({
        teamId: opts.teamId,
        projectId: opts.projectId,
        title: opts.title,
        description: opts.description,
        stateId: opts.stateId,
        priority: opts.priority,
        labelIds: opts.labelIds,
        parentId: opts.parentId,
      }),
    "createIssue",
  );
  const issue = await payload.issue;
  if (!issue) throw new Error("Failed to create issue");
  return issue;
}

/**
 * Verify the Linear API connection works.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getLinearClient();
    const viewer = await client.viewer;
    info(`Connected to Linear as ${viewer.name ?? viewer.email}`);
    return true;
  } catch (e) {
    warn(`Linear connection failed: ${e}`);
    return false;
  }
}

/**
 * Resolve a LinearConfig to team/project/state IDs for use in API calls.
 */
export async function resolveLinearIds(
  config: LinearConfig,
): Promise<LinearIds> {
  const [team, project] = await Promise.all([
    findTeam(config.team),
    findProject(config.project),
  ]);

  const [
    triageState,
    readyState,
    inProgressState,
    inReviewState,
    doneState,
    blockedState,
  ] = await Promise.all([
    findState(team.id, config.states.triage),
    findState(team.id, config.states.ready),
    findState(team.id, config.states.in_progress),
    findState(team.id, config.states.in_review),
    findState(team.id, config.states.done),
    findState(team.id, config.states.blocked),
  ]);

  return {
    teamId: team.id,
    teamKey: config.team,
    projectId: project.id,
    projectName: config.project,
    states: {
      triage: triageState.id,
      ready: readyState.id,
      in_progress: inProgressState.id,
      in_review: inReviewState.id,
      done: doneState.id,
      blocked: blockedState.id,
    },
  };
}
