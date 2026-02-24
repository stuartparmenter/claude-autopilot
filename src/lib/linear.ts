import {
  type Issue,
  LinearClient,
  type Project,
  type Team,
  type WorkflowState,
} from "@linear/sdk";
import type { LinearConfig, LinearIds } from "./config";

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
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team '${teamKey}' not found in Linear`);
  return team;
}

/**
 * Find a project by name.
 */
export async function findProject(projectName: string): Promise<Project> {
  const client = getLinearClient();
  const projects = await client.projects({
    filter: { name: { eq: projectName } },
  });
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
  const states = await client.workflowStates({
    filter: { team: { id: { eq: teamId } }, name: { eq: stateName } },
  });
  const state = states.nodes[0];
  if (!state) throw new Error(`State '${stateName}' not found for team`);
  return state;
}

/**
 * Get ready, unblocked issues for a team+project, sorted by priority.
 */
export async function getReadyIssues(
  linearIds: LinearIds,
  limit: number = 10,
): Promise<Issue[]> {
  const client = getLinearClient();

  const result = await client.issues({
    filter: {
      team: { id: { eq: linearIds.teamId } },
      state: { id: { eq: linearIds.states.ready } },
      project: { id: { eq: linearIds.projectId } },
    },
    first: limit,
  });

  // Sort by priority (lower number = higher priority in Linear)
  const sorted = [...result.nodes].sort(
    (a, b) => (a.priority ?? 4) - (b.priority ?? 4),
  );

  // Filter out issues that are blocked by incomplete issues
  const unblocked: Issue[] = [];

  for (const issue of sorted) {
    const relations = await issue.relations();
    let isBlocked = false;

    for (const relation of relations.nodes) {
      if (relation.type === "blocks") {
        const related = await relation.relatedIssue;
        if (related) {
          const state = await related.state;
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
  let result = await client.issues({
    filter: {
      team: { id: { eq: linearIds.teamId } },
      state: { id: { eq: stateId } },
      project: { id: { eq: linearIds.projectId } },
    },
    first: 250,
  });

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
    await client.updateIssue(issueId, { stateId: opts.stateId });
  }

  if (opts.comment) {
    await client.createComment({ issueId, body: opts.comment });
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
  const payload = await client.createIssue({
    teamId: opts.teamId,
    projectId: opts.projectId,
    title: opts.title,
    description: opts.description,
    stateId: opts.stateId,
    priority: opts.priority,
    labelIds: opts.labelIds,
    parentId: opts.parentId,
  });
  const issue = await payload.issue;
  if (!issue) throw new Error("Failed to create issue");
  return issue;
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
