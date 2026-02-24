#!/usr/bin/env bun

/**
 * main.ts — Single entry point for claude-autopilot.
 *
 * Usage: bun run start <project-path> [--port 7890]
 */

import { runAudit, shouldRunAudit } from "./auditor";
import { fillSlots } from "./executor";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { resolveLinearIds } from "./lib/linear";
import { error, header, info, ok, warn } from "./lib/logger";
import { createApp } from "./server";
import { AppState } from "./state";

// --- Parse args ---

const args = process.argv.slice(2);
let projectArg: string | undefined;
let port = 7890;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = Number.parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith("-")) {
    projectArg = args[i];
  }
}

if (!projectArg) {
  console.log("Usage: bun run start <project-path> [--port 7890]");
  console.log();
  console.log("Start the claude-autopilot loop with a web dashboard.");
  console.log();
  console.log("Options:");
  console.log("  --port <number>  Dashboard port (default: 7890)");
  process.exit(1);
}

const projectPath = resolveProjectPath(projectArg);
const config = loadConfig(projectPath);

if (!config.linear.team)
  error("linear.team is not set in .claude-autopilot.yml");
if (!config.linear.project)
  error("linear.project is not set in .claude-autopilot.yml");
if (!config.project.name)
  error("project.name is not set in .claude-autopilot.yml");

// --- Check environment variables ---

if (!process.env.LINEAR_API_KEY) {
  error(
    "LINEAR_API_KEY environment variable is not set.\n" +
      "Create one at: https://linear.app/settings/api\n" +
      "Then: export LINEAR_API_KEY=lin_api_...",
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

header("claude-autopilot v0.2.0");

info(`Project: ${projectPath}`);
info(`Team: ${config.linear.team}, Project: ${config.linear.project}`);
info(`Max parallel: ${config.executor.parallel}`);
info(
  `Model: ${config.executor.model} (planning: ${config.executor.planning_model})`,
);

// --- Connect to Linear ---

info("Connecting to Linear...");
const linearIds = await resolveLinearIds(config.linear);
ok(`Connected - team ${config.linear.team}, project ${config.linear.project}`);

// --- Init state and server ---

const state = new AppState();
const app = createApp(state);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

ok(`Dashboard: http://localhost:${server.port}`);
console.log();

// --- Helpers ---

/** Redact sensitive tokens from error messages before logging. */
function sanitizeMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]")
    .replace(/lin_api_\S+/g, "lin_api_[REDACTED]")
    .replace(/sk-ant-\S+/g, "sk-ant-[REDACTED]");
}

/** Sleep that resolves immediately when the abort signal fires. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

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
  info("Shutting down - waiting for running agents to finish...");
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
  shutdownController.abort();
  process.exit(1);
});

// --- Main loop ---

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const running = new Set<Promise<boolean>>();
let auditorPromise: Promise<void> | null = null;

info("Starting main loop (Ctrl+C to stop)...");
console.log();

while (!shuttingDown) {
  try {
    if (state.isPaused()) {
      await interruptibleSleep(POLL_INTERVAL_MS, shutdownController.signal);
      continue;
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
        }).finally(() => {
          auditorPromise = null;
        });
      }
    }

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
    const msg = e instanceof Error ? e.message : String(e);
    info(`Loop error: ${msg}`);
    info("Retrying in 60 seconds...");
    await interruptibleSleep(60_000, shutdownController.signal);
  }
}

// --- Drain phase ---

const drainablePromises: Promise<unknown>[] = [...running];
if (auditorPromise) drainablePromises.push(auditorPromise);

if (drainablePromises.length > 0) {
  info(
    `Waiting for ${drainablePromises.length} agent(s) to finish (up to 60s)...`,
  );
  await Promise.race([
    Promise.allSettled(drainablePromises),
    Bun.sleep(60_000),
  ]);
}

server.stop();
info("Shutdown complete.");
process.exit(0);
