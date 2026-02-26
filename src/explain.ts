#!/usr/bin/env bun

/**
 * explain.ts — Read-only planning preview for a target project.
 *
 * Usage: bun run explain <project-path>
 *
 * Connects to Linear (read-only), investigates the codebase with the explain
 * prompt, and prints a structured report to stdout without filing any issues.
 */

import { resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { buildMcpServers, runClaude } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { detectRepo } from "./lib/github";
import { resolveLinearIds } from "./lib/linear";
import { fatal, header, info, ok, warn } from "./lib/logger";
import { AUTOPILOT_ROOT, buildPrompt } from "./lib/prompt";

// --- Parse args ---

const projectArg = process.argv[2];
if (!projectArg) {
  console.log("Usage: bun run explain <project-path>");
  console.log();
  console.log("Run a read-only planning preview for the given project.");
  console.log("Connects to Linear (read-only), investigates the codebase,");
  console.log("and prints a structured report without filing any issues.");
  process.exit(1);
}

header("claude-autopilot explain");

const projectPath = resolveProjectPath(projectArg);
info(`Project: ${projectPath}`);

const config = loadConfig(projectPath);

// --- Check environment variables ---

if (!process.env.LINEAR_API_KEY) {
  fatal(
    "LINEAR_API_KEY environment variable is not set.\n" +
      "Create one at: https://linear.app/settings/api\n" +
      "Then: export LINEAR_API_KEY=lin_api_...",
  );
}

if (!config.linear.team) {
  fatal("linear.team is not set in .claude-autopilot.yml");
}

if (!process.env.GITHUB_TOKEN) {
  warn(
    "GITHUB_TOKEN environment variable is not set.\n" +
      "The GitHub MCP inside the agent may fail without it.\n" +
      "Set: export GITHUB_TOKEN=ghp_...",
  );
}

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
  `Connected — team ${config.linear.team}` +
    (linearIds.initiativeName
      ? `, initiative ${linearIds.initiativeName}`
      : ""),
);

// --- Graceful shutdown ---

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

// --- Build and run explain agent ---

const vars = {
  LINEAR_TEAM: config.linear.team,
  MAX_ISSUES_PER_RUN: String(config.planning.max_issues_per_run),
  REPO_NAME: projectPath.split("/").pop() || "unknown",
  INITIATIVE_NAME: linearIds.initiativeName || "Not configured",
  INITIATIVE_ID: linearIds.initiativeId || "",
  TRIAGE_STATE: config.linear.states.triage,
  READY_STATE: config.linear.states.ready,
  TODAY: new Date().toISOString().slice(0, 10),
};

const prompt = buildPrompt("explain", vars, projectPath);
const plugins: SdkPluginConfig[] = [
  {
    type: "local",
    path: resolve(AUTOPILOT_ROOT, "plugins/planning-skills"),
  },
];

info("Starting explain agent...");

const result = await runClaude({
  prompt,
  cwd: projectPath,
  label: "explain",
  timeoutMs: config.planning.timeout_minutes * 60 * 1000,
  inactivityMs: config.executor.inactivity_timeout_minutes * 60 * 1000,
  model: config.planning.model,
  sandbox: config.sandbox,
  mcpServers: buildMcpServers(),
  plugins,
  parentSignal: controller.signal,
});

// --- Output result ---

if (result.timedOut || result.error) {
  warn(result.error || "Agent timed out without producing a result");
  process.exit(1);
}

console.log();
console.log(result.result);
console.log();

info(
  `Completed` +
    (result.durationMs ? ` in ${Math.round(result.durationMs / 1000)}s` : "") +
    (result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : "") +
    (result.numTurns ? `, ${result.numTurns} turns` : ""),
);

process.exit(0);
