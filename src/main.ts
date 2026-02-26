#!/usr/bin/env bun

/**
 * main.ts — Single entry point for claude-autopilot.
 *
 * Usage: bun run start <project-path> [--port 7890] [--host 127.0.0.1]
 */

import { resolve } from "node:path";
import { RatelimitedLinearError } from "@linear/sdk";
import { runAudit, shouldRunAudit } from "./auditor";
import { fillSlots } from "./executor";
import { closeAllAgents } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { openDb, pruneActivityLogs } from "./lib/db";
import { interruptibleSleep, isFatalError } from "./lib/errors";
import { detectRepo } from "./lib/github";
import { resolveLinearIds, updateIssue } from "./lib/linear";
import { error, fatal, header, info, ok, warn } from "./lib/logger";
import { sanitizeMessage } from "./lib/sanitize";
import { checkOpenPRs } from "./monitor";
import { createApp } from "./server";
import { AppState } from "./state";

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
  console.log("Start the claude-autopilot loop with a web dashboard.");
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

if (!config.linear.team)
  fatal("linear.team is not set in .claude-autopilot.yml");
if (!config.linear.project)
  fatal("linear.project is not set in .claude-autopilot.yml");
if (!config.project.name)
  fatal("project.name is not set in .claude-autopilot.yml");

// --- Check environment variables ---

if (!process.env.LINEAR_API_KEY) {
  fatal(
    "LINEAR_API_KEY environment variable is not set.\n" +
      "Create one at: https://linear.app/settings/api\n" +
      "Then: export LINEAR_API_KEY=lin_api_...",
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

header("claude-autopilot v0.2.0");

info(`Project: ${projectPath}`);
info(`Team: ${config.linear.team}, Project: ${config.linear.project}`);
info(`Max parallel: ${config.executor.parallel}`);
info(`Poll interval: ${config.executor.poll_interval_minutes}m`);
info(
  `Model: ${config.executor.model} (planning: ${config.executor.planning_model})`,
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
ok(`Connected - team ${config.linear.team}, project ${config.linear.project}`);

// --- Init state and server ---

const state = new AppState();

if (config.persistence.enabled) {
  const dbPath = resolve(projectPath, config.persistence.db_path);
  const db = openDb(dbPath);
  state.setDb(db);
  const pruned = pruneActivityLogs(db, config.persistence.retention_days);
  if (pruned > 0) info(`Pruned ${pruned} old activity log entries`);
  ok(`Persistence: ${dbPath}`);
}

const app = createApp(state, {
  authToken: dashboardToken,
  secureCookie: !isLocalhost,
  config,
  triggerAudit: () => {
    runAudit({
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

function shutdown() {
  if (shuttingDown) {
    info("Force quitting...");
    process.exit(1);
  }
  shuttingDown = true;
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
const BASE_BACKOFF_MS = 10_000; // 10s
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_FAILURES = 5;
const running = new Set<Promise<boolean>>();
let auditorPromise: Promise<void> | null = null;

let consecutiveFailures = 0;

info("Starting main loop (Ctrl+C to stop)...");
console.log();

while (!shuttingDown) {
  try {
    if (state.isPaused()) {
      await interruptibleSleep(POLL_INTERVAL_MS, shutdownController.signal);
      continue;
    }

    if (shuttingDown) break;

    // Check open PRs and spawn fixers for failures/conflicts
    const fixerPromises = await checkOpenPRs({
      owner: ghOwner,
      repo: ghRepo,
      config,
      projectPath,
      linearIds,
      state,
      shutdownSignal: shutdownController.signal,
    });
    for (const p of fixerPromises) {
      const tracked = p.finally(() => running.delete(tracked));
      running.add(tracked);
    }

    // Fill executor slots
    const newPromises = await fillSlots({
      config,
      projectPath,
      linearIds,
      state,
      shutdownSignal: shutdownController.signal,
    });
    for (const p of newPromises) {
      // Each promise self-removes from the set when it settles
      const tracked = p.finally(() => running.delete(tracked));
      running.add(tracked);
    }

    // Check auditor (counts against parallel limit)
    if (
      !state.getAuditorStatus().running &&
      state.getRunningCount() < config.executor.parallel
    ) {
      const shouldAudit = await shouldRunAudit({
        config,
        linearIds,
        state,
      });
      if (shouldAudit) {
        auditorPromise = runAudit({
          config,
          projectPath,
          linearIds,
          state,
          shutdownSignal: shutdownController.signal,
        })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            warn(`Auditor error: ${msg}`);
            state.updateAuditor({ running: false, lastResult: "failed" });
          })
          .finally(() => {
            auditorPromise = null;
          });
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
if (auditorPromise) drainablePromises.push(auditorPromise);

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

server.stop();
info("Shutdown complete.");
process.exit(0);
