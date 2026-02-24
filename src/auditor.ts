#!/usr/bin/env bun

/**
 * auditor.ts — Scan the codebase and file Linear issues for improvements
 *
 * Usage: bun run auditor <project-path>
 */

import { runClaude } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { countIssuesInState, resolveLinearIds } from "./lib/linear";
import { error, info, ok, warn } from "./lib/logger";
import { buildAuditorPrompt } from "./lib/prompt";

const projectPath = resolveProjectPath(process.argv[2]);
const config = loadConfig(projectPath);

if (!config.linear.team)
  error("linear.team is not set in .claude-autopilot.yml");
if (!config.project.name)
  error("project.name is not set in .claude-autopilot.yml");

info("Configuration loaded:");
info(`  Team: ${config.linear.team}`);
info(`  Project: ${config.linear.project || "(none)"}`);
info(`  Triage state: ${config.linear.states.triage}`);
info(`  Max issues per run: ${config.auditor.max_issues_per_run}`);
info(`  Project: ${config.project.name}`);

// Resolve Linear IDs
info("Connecting to Linear...");
const linearIds = await resolveLinearIds(config.linear);
ok(`Connected — team ${config.linear.team}`);

// Check if we should run (backlog threshold)
const readyCount = await countIssuesInState(
  linearIds.teamId,
  linearIds.states.ready,
);
info(`Current ready issues: ${readyCount}`);
info(`Threshold: ${config.auditor.min_ready_threshold}`);

if (
  config.auditor.schedule === "when_idle" &&
  readyCount >= config.auditor.min_ready_threshold
) {
  ok(
    `Backlog is sufficient (${readyCount} >= ${config.auditor.min_ready_threshold}), skipping audit.`,
  );
  process.exit(0);
}

// Build the full auditor prompt with subagent references
info("Building auditor prompt...");

const prompt = buildAuditorPrompt({
  LINEAR_TEAM: config.linear.team,
  LINEAR_PROJECT: config.linear.project,
  TRIAGE_STATE: config.linear.states.triage,
  MAX_ISSUES_PER_RUN: String(config.auditor.max_issues_per_run),
  PROJECT_NAME: config.project.name,
  TECH_STACK: config.project.tech_stack,
});

// Run the auditor
const TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

info("Starting auditor (timeout: 60 minutes)...");
info("The auditor will scan the codebase and file issues to Linear Triage.");
console.log();
console.log("==========================================");
console.log();

const result = await runClaude({
  prompt,
  cwd: projectPath,
  timeoutMs: TIMEOUT_MS,
});

console.log();
console.log("==========================================");
console.log();

if (result.timedOut) {
  warn("Auditor timed out after 60 minutes");
  warn("Partial results may have been filed to Linear");
} else if (result.error) {
  warn(`Auditor failed: ${result.error}`);
} else {
  ok("Auditor completed successfully");
  if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.numTurns) info(`Turns: ${result.numTurns}`);
}

console.log();
info("Check your Linear Triage queue for new issues filed by the auditor.");
info("Review them carefully before promoting to Ready.");
console.log();
