#!/usr/bin/env bun

/**
 * main.ts — Single entry point for autopilot.
 *
 * Usage: bun run start <project-path> [--port 7890] [--host 127.0.0.1]
 */

import { resolve } from "node:path";
import { RatelimitedLinearError } from "@linear/sdk";
import {
  fillSlots,
  recoverAgentsOnShutdown,
  recoverStaleIssues,
} from "./executor";
import { closeAllAgents } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { openDb, pruneActivityLogs } from "./lib/db";
import { interruptibleSleep, isFatalError } from "./lib/errors";
import { detectRepo } from "./lib/github";
import { getTriageIssues, resolveLinearIds, updateIssue } from "./lib/linear";
import { getCurrentLinearToken, initLinearAuth } from "./lib/linear-oauth";
import { error, fatal, header, info, ok, warn } from "./lib/logger";
import { sanitizeMessage } from "./lib/sanitize";
import { sweepWorktrees } from "./lib/worktree";
import { checkOpenPRs } from "./monitor";
import { runPlanning, shouldRunPlanning } from "./planner";
import { checkProjects } from "./projects";
import { createApp } from "./server";
import { type AgentState, AppState } from "./state";

// --- Parse args ---

const args = process.argv.slice(2);
let projectArg: string | undefined;
let port = 7890;
let host = "127.0.0.1";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = Number.parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--host" && args[i + 1]) {
    host = args[i + 1];
    i++;
  } else if (!args[i].startsWith("-")) {
    projectArg = args[i];
  }
}

if (!projectArg) {
  console.log(
    "Usage: bun run start <project-path> [--port 7890] [--host 127.0.0.1]",
  );
  console.log();
  console.log("Start the autopilot loop with a web dashboard.");
  console.log();
  console.log("Options:");
  console.log("  --port <number>   Dashboard port (default: 7890)");
  console.log(
    "  --host <address>  Dashboard bind address (default: 127.0.0.1)",
  );
  process.exit(1);
}

const projectPath = resolveProjectPath(projectArg);
const config = loadConfig(projectPath);

if (!config.linear.team) fatal("linear.team is not set in .autopilot.yml");

// --- Initialize Linear auth (OAuth or API key) ---

// Always open the DB for OAuth token storage, regardless of persistence.enabled
const authDbPath = resolve(projectPath, config.persistence.db_path);
const authDb = openDb(authDbPath);
await initLinearAuth(authDb);

if (!getCurrentLinearToken()) {
  fatal(
    "No Linear authentication configured.\n" +
      "Option 1: Set LINEAR_API_KEY environment variable.\n" +
      "  Create one at: https://linear.app/settings/api\n" +
      "  Then: export LINEAR_API_KEY=lin_api_...\n" +
      "Option 2: Connect via OAuth at the dashboard (/auth/linear).\n" +
      "  Required: LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars.",
  );
}

if (!process.env.GITHUB_TOKEN) {
  error(
    "GITHUB_TOKEN environment variable is not set.\n" +
      "Create one at: https://github.com/settings/tokens\n" +
      "Required scopes: repo (for PR monitoring and GitHub MCP).\n" +
      "Then: export GITHUB_TOKEN=ghp_...",
  );
}

// The Agent SDK accepts ANTHROPIC_API_KEY or Claude Code subscription auth.
// Check common env vars so the user gets a clear message instead of a cryptic
// failure minutes into the run when the first agent spawns.
if (
  !process.env.ANTHROPIC_API_KEY &&
  !process.env.CLAUDE_API_KEY &&
  !process.env.CLAUDE_CODE_USE_BEDROCK &&
  !process.env.CLAUDE_CODE_USE_VERTEX
) {
  info(
    "WARNING: No Anthropic API key found (ANTHROPIC_API_KEY or CLAUDE_API_KEY).",
  );
  info(
    "If you are using Claude Code subscription auth, this is fine. Otherwise,",
  );
  info("agents will fail when they try to make API calls.");
  info("Set: export ANTHROPIC_API_KEY=sk-ant-...");
  console.log();
}

const dashboardToken = process.env.AUTOPILOT_DASHBOARD_TOKEN || undefined;
const isLocalhost =
  host === "127.0.0.1" || host === "localhost" || host === "::1";

if (!isLocalhost && !dashboardToken) {
  fatal(
    `AUTOPILOT_DASHBOARD_TOKEN must be set when binding dashboard to non-localhost.\n` +
      `Set: export AUTOPILOT_DASHBOARD_TOKEN=<your-secret-token>\n` +
      `Or bind to localhost only (omit --host).`,
  );
}

header("autopilot v0.2.0");

info(`Project: ${projectPath}`);
info(
  `Team: ${config.linear.team}` +
    (config.linear.initiative
      ? `, Initiative: ${config.linear.initiative}`
      : ""),
);
info(`Max parallel: ${config.executor.parallel}`);
info(`Poll interval: ${config.executor.poll_interval_minutes}m`);
if (config.projects.enabled && config.linear.initiative) {
  info(
    `Projects loop: every ${config.projects.poll_interval_minutes}m, max ${config.projects.max_active_projects} owners`,
  );
}
info(
  `Models: executor=${config.executor.model}, planning=${config.planning.model}, projects=${config.projects.model}`,
);

// --- Detect GitHub repo ---

const { owner: ghOwner, repo: ghRepo } = detectRepo(
  projectPath,
  config.github.repo || undefined,
);
ok(`GitHub repo: ${ghOwner}/${ghRepo}`);

// --- Connect to Linear ---

info("Connecting to Linear...");
const linearIds = await resolveLinearIds(config.linear);
ok(
  `Connected - team ${config.linear.team}` +
    (linearIds.initiativeName
      ? `, initiative ${linearIds.initiativeName}`
      : ""),
);

// --- Init state and server ---

const state = new AppState(config.executor.parallel);

if (config.persistence.enabled) {
  // Reuse the already-opened authDb (same file) for persistence
  state.setDb(authDb);
  const pruned = pruneActivityLogs(authDb, config.persistence.retention_days);
  if (pruned > 0) info(`Pruned ${pruned} old activity log entries`);
  ok(`Persistence: ${authDbPath}`);
}

const app = createApp(state, {
  authToken: dashboardToken,
  secureCookie: !isLocalhost,
  config,
  db: authDb,
  triggerPlanning: () => {
    runPlanning({
      config,
      projectPath,
      linearIds,
      state,
      shutdownSignal: shutdownController.signal,
    });
  },
  retryIssue: async (linearIssueId: string) => {
    await updateIssue(linearIssueId, { stateId: linearIds.states.ready });
  },
  triageIssues: async () => {
    const issues = await getTriageIssues(linearIds);
    return issues.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      priority: i.priority ?? 4,
    }));
  },
  approveTriageIssue: async (issueId: string) => {
    await updateIssue(issueId, { stateId: linearIds.states.ready });
  },
  rejectTriageIssue: async (issueId: string) => {
    await updateIssue(issueId, { stateId: linearIds.states.blocked });
  },
});

if (!isLocalhost) {
  warn(`Dashboard bound to ${host}:${port} — accessible from the network.`);
  warn("  The dashboard has NO authentication. Anyone on the network can:");
  warn("  - View all agent activity, issue titles, and execution history");
  warn("  - Pause and resume the executor loop via POST /api/pause");
  warn(
    "  Consider using --host 127.0.0.1 (the default) or adding a reverse proxy with auth.",
  );
}

const server = Bun.serve({
  port,
  hostname: host,
  fetch: app.fetch,
});

if (dashboardToken) {
  ok("Dashboard authentication enabled");
} else {
  info("Dashboard authentication disabled (localhost-only)");
}
ok(`Dashboard: http://${isLocalhost ? "localhost" : host}:${server.port}`);
console.log();

// --- Graceful shutdown ---

const shutdownController = new AbortController();
let shuttingDown = false;
let agentsAtShutdown: AgentState[] = [];

function shutdown() {
  if (shuttingDown) {
    info("Force quitting...");
    process.exit(1);
  }
  shuttingDown = true;
  // Capture running agents synchronously before killing subprocesses,
  // so the drain phase can move their Linear issues back to Ready.
  agentsAtShutdown = state.getRunningAgents();
  console.log();
  info("Shutting down — killing agent subprocesses...");
  // close() is synchronous: sends SIGTERM immediately, escalates to SIGKILL
  // after 5s. Call this BEFORE abort() so processes are killed even if the
  // async cleanup chain doesn't complete.
  closeAllAgents();
  shutdownController.abort();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  warn(`Unhandled rejection: ${sanitizeMessage(msg)}`);
});

process.on("uncaughtException", (err) => {
  // Must be synchronous only — the process is in undefined state after uncaught exception
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ERROR] Uncaught exception: ${sanitizeMessage(msg)}\n`);
  closeAllAgents();
  shutdownController.abort();
  process.exit(1);
});

// --- Main loop ---

const POLL_INTERVAL_MS = config.executor.poll_interval_minutes * 60 * 1000;
const PROJECTS_INTERVAL_MS = config.projects.poll_interval_minutes * 60 * 1000;
const BASE_BACKOFF_MS = 10_000; // 10s
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_FAILURES = 5;
const running = new Set<Promise<boolean>>();
let planningPromise: Promise<void> | null = null;
let lastProjectsCheckAt = 0;

let consecutiveFailures = 0;

// Sweep stale worktrees left behind by previous crashed runs.
// No agents are running yet, so every worktree found is stale.
await sweepWorktrees(projectPath, new Set());

info("Starting main loop (Ctrl+C to stop)...");
console.log();

while (!shuttingDown) {
  try {
    if (state.isPaused()) {
      await interruptibleSleep(POLL_INTERVAL_MS, shutdownController.signal);
      continue;
    }

    if (shuttingDown) break;

    // Recover stale In Progress issues before filling slots
    await recoverStaleIssues({ config, linearIds, state });

    // Run monitor and executor concurrently. fillSlots may read a slightly
    // lower running count if checkOpenPRs has not yet registered its fixers
    // (it is still fetching attachments), but transient over-allocation by
    // 1-2 agents is accepted as harmless. Promise.allSettled ensures a failure
    // in one subsystem does not prevent the other from running.
    const [monitorResult, executorResult] = await Promise.allSettled([
      checkOpenPRs({
        owner: ghOwner,
        repo: ghRepo,
        config,
        projectPath,
        linearIds,
        state,
        shutdownSignal: shutdownController.signal,
      }),
      fillSlots({
        config,
        projectPath,
        linearIds,
        state,
        shutdownSignal: shutdownController.signal,
      }),
    ]);

    if (monitorResult.status === "fulfilled") {
      for (const p of monitorResult.value) {
        const tracked = p.finally(() => running.delete(tracked));
        running.add(tracked);
      }
    } else {
      const msg =
        monitorResult.reason instanceof Error
          ? monitorResult.reason.message
          : String(monitorResult.reason);
      warn(`Monitor error: ${msg}`);
    }

    if (executorResult.status === "fulfilled") {
      for (const p of executorResult.value) {
        // Each promise self-removes from the set when it settles
        const tracked = p.finally(() => running.delete(tracked));
        running.add(tracked);
      }
    } else {
      const msg =
        executorResult.reason instanceof Error
          ? executorResult.reason.message
          : String(executorResult.reason);
      warn(`Executor error: ${msg}`);
    }

    // Check planning (counts against parallel limit)
    if (
      !state.getPlanningStatus().running &&
      state.getRunningCount() < state.getMaxParallel()
    ) {
      const shouldPlan = await shouldRunPlanning({
        config,
        linearIds,
        state,
      });
      if (shouldPlan) {
        planningPromise = runPlanning({
          config,
          projectPath,
          linearIds,
          state,
          shutdownSignal: shutdownController.signal,
        })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            warn(`Planning error: ${msg}`);
          })
          .finally(() => {
            planningPromise = null;
          });
      }
    }

    // Check projects loop
    if (
      config.projects.enabled &&
      linearIds.initiativeId &&
      Date.now() - lastProjectsCheckAt >= PROJECTS_INTERVAL_MS
    ) {
      lastProjectsCheckAt = Date.now();
      const projectPromises = await checkProjects({
        config,
        projectPath,
        linearIds,
        state,
        shutdownSignal: shutdownController.signal,
      });
      for (const p of projectPromises) {
        const tracked = p.finally(() => running.delete(tracked));
        running.add(tracked);
      }
    }

    // Reset failure counter after a successful iteration
    consecutiveFailures = 0;

    // Wait for any agent to finish or poll interval to elapse
    if (running.size > 0) {
      const pollTimer = interruptibleSleep(
        POLL_INTERVAL_MS,
        shutdownController.signal,
      ).then(() => "poll" as const);
      await Promise.race([pollTimer, ...running]);
    } else {
      info(
        `No agents running. Polling again in ${POLL_INTERVAL_MS / 1000}s...`,
      );
      await interruptibleSleep(POLL_INTERVAL_MS, shutdownController.signal);
    }
  } catch (e) {
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const msg = e instanceof Error ? e.message : String(e);

    if (isFatalError(e)) {
      fatal(`Fatal error — check your API key and config: ${msg}\n${stack}`);
    }

    consecutiveFailures++;
    info(`Stack trace: ${stack}`);

    if (e instanceof RatelimitedLinearError) {
      const retryAfterMs =
        e.retryAfter != null
          ? Math.min(e.retryAfter * 1000, MAX_BACKOFF_MS)
          : BASE_BACKOFF_MS;
      warn(
        `Rate limited by Linear. Retrying in ${Math.round(retryAfterMs / 1000)}s...`,
      );
      await Bun.sleep(retryAfterMs);
    } else {
      const backoffMs = Math.min(
        BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
        MAX_BACKOFF_MS,
      );
      warn(
        `Loop error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${msg}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        fatal(
          `${MAX_CONSECUTIVE_FAILURES} consecutive failures — exiting. Last error: ${msg}`,
        );
      }
      info(`Retrying in ${Math.round(backoffMs / 1000)}s...`);
      await Bun.sleep(backoffMs);
    }
  }
}

// --- Drain phase ---

const drainablePromises: Promise<unknown>[] = [...running];
if (planningPromise) drainablePromises.push(planningPromise);

if (drainablePromises.length > 0) {
  info(
    `Waiting for ${drainablePromises.length} agent(s) to shut down (up to 60s)...`,
  );
  // Wait at least 6s so the SDK's SIGKILL escalation timer (5s after close())
  // has time to fire before we exit. This ensures SIGTERM-resistant children
  // are forcefully killed rather than becoming orphans.
  await Promise.race([
    Promise.all([Promise.allSettled(drainablePromises), Bun.sleep(6_000)]),
    Bun.sleep(60_000),
  ]);
}

// --- Recover In Progress issues on shutdown ---

const issueCount = agentsAtShutdown.filter((a) => a.linearIssueId).length;
if (issueCount > 0) {
  info(`Recovering ${issueCount} In Progress issue(s) back to Ready...`);
  await recoverAgentsOnShutdown(agentsAtShutdown, linearIds.states.ready);
}

server.stop();
info("Shutdown complete.");
process.exit(0);
