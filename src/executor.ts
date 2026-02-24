#!/usr/bin/env bun

/**
 * executor.ts — Execute Linear issues autonomously using Claude Code
 *
 * Usage:
 *   bun run executor <project-path> [once|loop]
 */

import { runClaude } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { getReadyIssues, resolveLinearIds, updateIssue } from "./lib/linear";
import { error, info, ok, warn } from "./lib/logger";
import { buildPrompt } from "./lib/prompt";

const projectPath = resolveProjectPath(process.argv[2]);
const mode = (process.argv[3] ?? "once") as "once" | "loop";

if (mode !== "once" && mode !== "loop") {
  console.error("Usage: bun run executor <project-path> [once|loop]");
  console.error();
  console.error("Modes:");
  console.error("  once  Execute one issue and exit (default)");
  console.error("  loop  Continuously execute issues until none remain");
  process.exit(1);
}

const config = loadConfig(projectPath);

if (!config.linear.team)
  error("linear.team is not set in .claude-autopilot.yml");
if (!config.project.name)
  error("project.name is not set in .claude-autopilot.yml");

info("Configuration loaded:");
info(`  Team: ${config.linear.team}`);
info(`  Ready state: ${config.linear.states.ready}`);
info(`  Project: ${config.project.name}`);
info(`  Mode: ${mode}`);

// Resolve Linear IDs upfront
info("Connecting to Linear...");
const linearIds = await resolveLinearIds(config.linear);
ok(`Connected — team ${config.linear.team} (${linearIds.teamId})`);

// --- Execute a single issue ---

async function executeIssue(issue: {
  id: string;
  identifier: string;
  title: string;
}): Promise<boolean> {
  info(`Executing: ${issue.identifier} — ${issue.title}`);
  info(`Timeout: ${config.executor.timeout_minutes} minutes`);

  const prompt = buildPrompt("executor", {
    ISSUE_ID: issue.identifier,
    TEST_COMMAND:
      config.project.test_command || "echo 'No test command configured'",
    LINT_COMMAND:
      config.project.lint_command || "echo 'No lint command configured'",
    DONE_STATE: config.linear.states.done,
    BLOCKED_STATE: config.linear.states.blocked,
    PROJECT_NAME: config.project.name,
    TECH_STACK: config.project.tech_stack,
  });

  const worktree = `autopilot/${issue.identifier}`;
  const timeoutMs = config.executor.timeout_minutes * 60 * 1000;

  const result = await runClaude({
    prompt,
    cwd: projectPath,
    worktree,
    timeoutMs,
  });

  if (result.timedOut) {
    warn(
      `${issue.identifier} timed out after ${config.executor.timeout_minutes} minutes`,
    );
    await updateIssue(issue.id, {
      stateId: linearIds.states.blocked,
      comment: `Executor timed out after ${config.executor.timeout_minutes} minutes.\n\nThe implementation may be partially complete. Check the \`${worktree}\` branch for any progress.`,
    });
    return false;
  }

  if (result.error) {
    warn(`${issue.identifier} failed: ${result.error}`);
    // Don't update Linear here — Claude should have done it in the prompt.
    // If it didn't, the issue stays in Ready for retry.
    return false;
  }

  ok(`${issue.identifier} completed successfully`);
  if (result.costUsd) info(`Cost: $${result.costUsd.toFixed(4)}`);
  return true;
}

// --- Find and execute next issue ---

async function runOnce(): Promise<"executed" | "none" | "error"> {
  info("Querying Linear for ready unblocked issues...");

  try {
    const issues = await getReadyIssues(
      linearIds.teamId,
      linearIds.states.ready,
      1,
    );

    if (issues.length === 0) {
      info("No ready unblocked issues found");
      return "none";
    }

    const issue = issues[0];
    const success = await executeIssue({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    });

    return success ? "executed" : "executed"; // Executed either way, success tracked separately
  } catch (e) {
    warn(`Error: ${e}`);
    return "error";
  }
}

// --- Main ---

let consecutiveEmpty = 0;
let totalExecuted = 0;
const totalSuccess = 0;
const totalFailed = 0;

info(`Starting executor in '${mode}' mode...`);
console.log();

if (mode === "once") {
  const result = await runOnce();
  console.log();
  if (result === "executed") {
    ok(`Executed 1 issue (success: ${totalSuccess}, failed: ${totalFailed})`);
  } else {
    info("No issues to execute");
  }
} else {
  info("Loop mode — will run until no issues found 3 times in a row");
  info("Press Ctrl+C to stop");
  console.log();

  while (true) {
    const result = await runOnce();

    if (result === "none") {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        info("No issues found 3 times in a row, stopping");
        break;
      }
      info(`No issues found (${consecutiveEmpty}/3), sleeping 60s...`);
      await Bun.sleep(60_000);
    } else if (result === "error") {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        info("Too many consecutive errors, stopping");
        break;
      }
      info(`Error occurred (${consecutiveEmpty}/3), sleeping 60s...`);
      await Bun.sleep(60_000);
    } else {
      consecutiveEmpty = 0;
      totalExecuted++;
      info("Looking for next issue...");
    }
  }

  console.log();
  ok("Executor loop finished");
  ok(
    `Total executed: ${totalExecuted} (success: ${totalSuccess}, failed: ${totalFailed})`,
  );
}
