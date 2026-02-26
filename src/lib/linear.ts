import {
  type Initiative,
  type Issue,
  type IssueLabel,
  LinearClient,
  ProjectUpdateHealthType,
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
 * Reset the cached client. Used in tests to prevent singleton leakage.
 */
export function resetClient(): void {
  _client = null;
}

/**
 * Inject a mock client directly. Used in unit tests to avoid real API calls.
 */
export function setClientForTesting(client: LinearClient): void {
  _client = client;
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
 * Find an initiative by name, or create one if it doesn't exist.
 */
export async function findOrCreateInitiative(
  name: string,
): Promise<Initiative> {
  const client = getLinearClient();
  const initiatives = await withRetry(
    () => client.initiatives({ filter: { name: { eq: name } } }),
    "findOrCreateInitiative",
  );
  const existing = initiatives.nodes[0];
  if (existing) return existing;

  info(`Creating initiative '${name}'...`);
  const payload = await withRetry(
    () => client.createInitiative({ name }),
    "findOrCreateInitiative",
  );
  const initiative = await payload.initiative;
  if (!initiative) throw new Error(`Failed to create initiative '${name}'`);
  return initiative;
}

// Single GraphQL query that fetches ready issues with their relations (including
// related issue states) and children counts in one HTTP request, replacing the
// previous N+1 SDK lazy-loading pattern.
const GET_READY_ISSUES_QUERY = `
  query getReadyIssues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        id
        identifier
        title
        priority
        relations {
          nodes {
            type
            relatedIssue {
              id
              state {
                type
              }
            }
          }
        }
        children {
          nodes {
            id
          }
        }
      }
    }
  }
`;

interface ReadyIssueNode {
  id: string;
  identifier: string;
  title: string;
  priority?: number | null;
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        state: { type: string } | null;
      } | null;
    }>;
  };
  children: {
    nodes: Array<{ id: string }>;
  };
}

interface GetReadyIssuesResponse {
  issues: {
    nodes: ReadyIssueNode[];
  };
}

/**
 * Get ready, unblocked leaf issues across the team, sorted by priority.
 * Queries by team (not project) so issues in dynamically-created projects
 * are visible. Skips parent issues that have children.
 * Uses a single GraphQL request to fetch issues with relations and children.
 *
 * Optional filters:
 * - labels: only return issues matching any of these label names
 * - projects: only return issues in any of these project names (combined with
 *   labels via AND: issue must match both label and project)
 */
export async function getReadyIssues(
  linearIds: LinearIds,
  limit: number = 10,
  filters?: { labels?: string[]; projects?: string[] },
): Promise<Issue[]> {
  const client = getLinearClient();
  const filter = {
    team: { id: { eq: linearIds.teamId } },
    state: { id: { eq: linearIds.states.ready } },
    ...(filters?.labels?.length
      ? { labels: { some: { name: { in: filters.labels } } } }
      : {}),
    ...(filters?.projects?.length
      ? { project: { name: { in: filters.projects } } }
      : {}),
  };

  const response = await withRetry(
    () =>
      client.client.rawRequest<GetReadyIssuesResponse, Record<string, unknown>>(
        GET_READY_ISSUES_QUERY,
        { filter, first: limit },
      ),
    "getReadyIssues",
  );

  const nodes = response.data?.issues?.nodes ?? [];

  // Sort by priority (lower number = higher priority in Linear, undefined/null treated as 4)
  const sorted = [...nodes].sort(
    (a, b) => (a.priority ?? 4) - (b.priority ?? 4),
  );

  // Filter: exclude parent issues (have children) and issues blocked by incomplete issues
  const leafUnblocked: ReadyIssueNode[] = [];
  for (const node of sorted) {
    // Skip parent issues — only leaf issues are work units
    if (node.children.nodes.length > 0) continue;

    // Skip issues blocked by an incomplete related issue
    const isBlocked = node.relations.nodes.some(
      (rel) =>
        rel.type === "blocks" &&
        rel.relatedIssue !== null &&
        rel.relatedIssue.state !== null &&
        rel.relatedIssue.state.type !== "completed" &&
        rel.relatedIssue.state.type !== "canceled",
    );
    if (!isBlocked) {
      leafUnblocked.push(node);
    }
  }

  return leafUnblocked as unknown as Issue[];
}

// Minimal GraphQL query to count issues — fetches only { id } per node to
// minimize payload vs. the SDK's full Issue fragment (40+ fields).
const COUNT_ISSUES_QUERY = `
  query countIssues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface CountIssuesResponse {
  issues: {
    nodes: { id: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function getTriageIssues(
  linearIds: LinearIds,
  limit: number = 50,
): Promise<Issue[]> {
  const client = getLinearClient();
  const result = await withRetry(
    () =>
      client.issues({
        filter: {
          team: { id: { eq: linearIds.teamId } },
          state: { id: { eq: linearIds.states.triage } },
        },
        first: limit,
      }),
    "getTriageIssues",
  );
  return [...result.nodes].sort(
    (a, b) => (a.priority ?? 4) - (b.priority ?? 4),
  );
}

/**
 * Get all In Progress issues for the team.
 * Used by recoverStaleIssues() to find orphaned issues.
 */
export async function getInProgressIssues(
  linearIds: LinearIds,
  limit: number = 50,
): Promise<Issue[]> {
  const client = getLinearClient();
  const result = await withRetry(
    () =>
      client.issues({
        filter: {
          team: { id: { eq: linearIds.teamId } },
          state: { id: { eq: linearIds.states.in_progress } },
        },
        first: limit,
      }),
    "getInProgressIssues",
  );
  return [...result.nodes];
}

const MAX_PAGES = 100;

/**
 * Count issues in a given state across the team.
 * Uses a raw GraphQL query to fetch only { id } per node, reducing payload
 * by ~95% vs the SDK's full Issue fragment.
 */
export async function countIssuesInState(
  linearIds: LinearIds,
  stateId: string,
): Promise<number> {
  const client = getLinearClient();
  const filter = {
    team: { id: { eq: linearIds.teamId } },
    state: { id: { eq: stateId } },
  };

  let count = 0;
  let pages = 0;
  let after: string | null = null;

  while (true) {
    if (pages >= MAX_PAGES) {
      warn(
        `countIssuesInState: reached ${MAX_PAGES} page limit, returning partial count`,
      );
      break;
    }

    const response = await withRetry(
      () =>
        client.client.rawRequest<CountIssuesResponse, Record<string, unknown>>(
          COUNT_ISSUES_QUERY,
          {
            filter,
            first: 250,
            after,
          },
        ),
      pages === 0 ? "countIssuesInState" : "countIssuesInState (pagination)",
    );

    const issuesData = response.data?.issues;
    if (!issuesData) break;
    const { nodes, pageInfo } = issuesData;
    count += nodes.length;
    pages++;

    if (pageInfo.hasNextPage && pageInfo.endCursor) {
      after = pageInfo.endCursor;
    } else {
      break;
    }
  }

  return count;
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
 * Create a project-level status update in Linear.
 * The Linear MCP plugin only supports initiative-level updates, so we
 * expose this through the autopilot MCP server.
 */
export async function createProjectStatusUpdate(opts: {
  projectId: string;
  body: string;
  health?: "onTrack" | "atRisk" | "offTrack";
}): Promise<string> {
  const client = getLinearClient();
  const healthMap: Record<string, ProjectUpdateHealthType> = {
    onTrack: ProjectUpdateHealthType.OnTrack,
    atRisk: ProjectUpdateHealthType.AtRisk,
    offTrack: ProjectUpdateHealthType.OffTrack,
  };
  const payload = await withRetry(
    () =>
      client.createProjectUpdate({
        projectId: opts.projectId,
        body: opts.body,
        health: opts.health ? healthMap[opts.health] : undefined,
      }),
    "createProjectStatusUpdate",
  );
  const update = await payload.projectUpdate;
  if (!update) throw new Error("Failed to create project status update");
  return update.id;
}

/**
 * Validate a Linear issue identifier (e.g., "ENG-123").
 * Throws if the identifier contains path separators, spaces, or other
 * characters that could be dangerous when used in file paths or branch names.
 * Returns the identifier unchanged for convenience.
 */
export function validateIdentifier(identifier: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)) {
    throw new Error(
      `Invalid Linear issue identifier: "${identifier}". Expected format: TEAM-123`,
    );
  }
  return identifier;
}

/**
 * Verify the Linear API connection works.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getLinearClient();
    const viewer = await withRetry(() => client.viewer, "testConnection");
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
  const team = await findTeam(config.team);

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

  let initiativeId: string | undefined;
  let initiativeName: string | undefined;
  if (config.initiative) {
    const initiative = await findOrCreateInitiative(config.initiative);
    initiativeId = initiative.id;
    initiativeName = initiative.name;
  }

  return {
    teamId: team.id,
    teamKey: config.team,
    initiativeId,
    initiativeName,
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
