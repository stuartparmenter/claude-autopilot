import {
  type Issue,
  type IssueLabel,
  LinearClient,
  type WorkflowState,
} from "@linear/sdk";
import type { LinearConfig } from "./config";
import { info, warn } from "./logger";

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
export async function findTeam(teamKey: string) {
  const client = getLinearClient();
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team '${teamKey}' not found in Linear`);
  return team;
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
 * Find or create a label by name within a team.
 */
export async function findOrCreateLabel(
  teamId: string,
  name: string,
  color?: string,
): Promise<IssueLabel> {
  const client = getLinearClient();
  const labels = await client.issueLabels({
    filter: { team: { id: { eq: teamId } }, name: { eq: name } },
  });

  if (labels.nodes[0]) return labels.nodes[0];

  info(`Creating label '${name}'...`);
  const payload = await client.createIssueLabel({
    teamId,
    name,
    color: color ?? "#888888",
  });
  const label = await payload.issueLabel;
  if (!label) throw new Error(`Failed to create label '${name}'`);
  return label;
}

/**
 * Get ready, unblocked issues for a team, sorted by priority.
 */
export async function getReadyIssues(
  teamId: string,
  readyStateId: string,
  limit: number = 10,
): Promise<Issue[]> {
  const client = getLinearClient();

  const result = await client.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { id: { eq: readyStateId } },
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
 * Count issues in a given state.
 */
export async function countIssuesInState(
  teamId: string,
  stateId: string,
): Promise<number> {
  const client = getLinearClient();
  const _result = await client.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { id: { eq: stateId } },
    },
    first: 0,
  });
  // The SDK doesn't directly return a count on `first:0`, so we fetch with a high limit
  const allResult = await client.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { id: { eq: stateId } },
    },
    first: 250,
  });
  return allResult.nodes.length;
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
 * Create an issue in Linear.
 */
export async function createIssue(opts: {
  teamId: string;
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
 * Resolve a LinearConfig to team/state IDs for use in API calls.
 */
export async function resolveLinearIds(config: LinearConfig) {
  const team = await findTeam(config.team);
  const [triageState, readyState, inProgressState, doneState, blockedState] =
    await Promise.all([
      findState(team.id, config.states.triage),
      findState(team.id, config.states.ready),
      findState(team.id, config.states.in_progress),
      findState(team.id, config.states.done),
      findState(team.id, config.states.blocked),
    ]);

  return {
    teamId: team.id,
    teamKey: config.team,
    states: {
      triage: triageState.id,
      ready: readyState.id,
      in_progress: inProgressState.id,
      done: doneState.id,
      blocked: blockedState.id,
    },
  };
}
