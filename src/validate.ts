#!/usr/bin/env bun

/**
 * validate.ts — Dry-run validation for config, credentials, and prompt templates.
 *
 * Usage: bun run validate <project-path>
 *
 * Runs read-only checks against config, environment variables, Linear, GitHub,
 * and prompt templates without spawning agents or modifying any state.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AutopilotConfig } from "./lib/config";
import { loadConfig, resolveProjectPath } from "./lib/config";
import { detectRepo, getGitHubClient } from "./lib/github";
import { resolveLinearIds } from "./lib/linear";
import { error, header, info, ok } from "./lib/logger";
import { AUTOPILOT_ROOT, loadPrompt } from "./lib/prompt";
import { withRetry } from "./lib/retry";

// --- Exported check functions (used by validate CLI and tests) ---

/**
 * Check 1: Load and validate the project config file.
 * Reuses loadConfig() which validates all fields and ranges.
 */
export async function checkConfig(projectPath: string): Promise<string> {
  const config = loadConfig(projectPath);
  return `Loaded — team: ${config.linear.team || "(not set)"}`;
}

/**
 * Check 2: Verify required environment variables are present.
 * LINEAR_API_KEY and GITHUB_TOKEN are required.
 * ANTHROPIC_API_KEY (or equivalent) is required for agents to run.
 */
export async function checkEnvVars(): Promise<string> {
  const missing: string[] = [];
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY");
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");

  const hasAnthropicKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_USE_BEDROCK ||
    process.env.CLAUDE_CODE_USE_VERTEX;
  if (!hasAnthropicKey) missing.push("ANTHROPIC_API_KEY (or CLAUDE_API_KEY)");

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  return "LINEAR_API_KEY, GITHUB_TOKEN, ANTHROPIC_API_KEY — all set";
}

/**
 * Check 3: Verify the worktree base directory is writable.
 * Creates the directory if absent, then writes and removes a test file.
 */
export async function checkWorktreeDir(projectPath: string): Promise<string> {
  const worktreeBase = resolve(projectPath, ".claude", "worktrees");
  mkdirSync(worktreeBase, { recursive: true });
  const testFile = resolve(worktreeBase, `.validate-${Date.now()}`);
  writeFileSync(testFile, "validate");
  rmSync(testFile);
  return `${worktreeBase} is writable`;
}

/**
 * Check 4: Test the Linear connection by resolving all configured IDs.
 * Confirms the team exists and all workflow states can be found.
 * Uses withRetry() to avoid false negatives from transient errors.
 */
export async function checkLinear(config: AutopilotConfig): Promise<string> {
  if (!config.linear.team) throw new Error("linear.team is not set in config");
  const linearIds = await resolveLinearIds(config.linear);
  const stateCount = Object.keys(linearIds.states).length;
  const initiativePart = linearIds.initiativeName
    ? `, initiative: ${linearIds.initiativeName}`
    : "";
  return `Connected — team ${config.linear.team}, ${stateCount} states resolved${initiativePart}`;
}

/**
 * Check 5: Test the GitHub connection by authenticating and detecting the repo.
 * Uses withRetry() to avoid false negatives from transient errors.
 */
export async function checkGitHub(
  projectPath: string,
  config: AutopilotConfig,
): Promise<string> {
  const { owner, repo } = detectRepo(
    projectPath,
    config.github.repo || undefined,
  );
  const octokit = getGitHubClient();
  const { data: user } = await withRetry(
    () => octokit.rest.users.getAuthenticated(),
    "validateGitHub",
  );
  return `Connected as ${user.login} — repo ${owner}/${repo}`;
}

/**
 * Check 6: Load all bundled prompt templates and verify they render without
 * leaving unsubstituted {{VARIABLE}} placeholders.
 * Also checks for any project-local overrides at <projectPath>/.claude-autopilot/prompts/.
 */
export async function checkPromptTemplates(
  projectPath: string,
): Promise<string> {
  const promptsDir = resolve(AUTOPILOT_ROOT, "prompts");
  const files = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));

  const issues: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    const template = loadPrompt(name, projectPath);

    // Auto-extract all {{VARIABLE}} patterns and fill with dummy values
    const vars: Record<string, string> = {};
    for (const match of template.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      vars[match[1]] = "SAMPLE";
    }

    // Render and verify no patterns remain
    let rendered = template;
    for (const [key, value] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{{${key}}}`, value);
    }
    const remaining = rendered.match(/\{\{[A-Z_]+\}\}/g);
    if (remaining) {
      issues.push(`${file}: unsubstituted: ${remaining.join(", ")}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }

  const names = files.map((f) => f.replace(/\.md$/, "")).join(", ");
  return `${files.length} template(s) OK — ${names}`;
}

// --- CLI entry point ---

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function runCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, pass: true, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, detail: msg };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let projectArg: string | undefined;

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      projectArg = arg;
    }
  }

  if (!projectArg) {
    console.log("Usage: bun run validate <project-path>");
    console.log();
    console.log(
      "Validates config, credentials, Linear connection, GitHub connection,",
    );
    console.log("and prompt templates without modifying any state.");
    process.exit(1);
  }

  const projectPath = resolveProjectPath(projectArg);

  header("claude-autopilot validate");
  info(`Project: ${projectPath}`);
  console.log();

  // Load config once for checks that need it (Linear, GitHub)
  let config: AutopilotConfig | null = null;
  try {
    config = loadConfig(projectPath);
  } catch {
    // Config failure is captured in the checkConfig result below
  }

  const checks: Array<[string, () => Promise<string>]> = [
    ["Config", () => checkConfig(projectPath)],
    ["Environment variables", () => checkEnvVars()],
    ["Worktree directory", () => checkWorktreeDir(projectPath)],
    [
      "Linear connection",
      () => {
        if (!config) throw new Error("Skipped — config failed to load");
        return checkLinear(config);
      },
    ],
    [
      "GitHub connection",
      () => {
        if (!config) throw new Error("Skipped — config failed to load");
        return checkGitHub(projectPath, config);
      },
    ],
    ["Prompt templates", () => checkPromptTemplates(projectPath)],
  ];

  const results: CheckResult[] = [];
  for (const [name, fn] of checks) {
    results.push(await runCheck(name, fn));
  }

  console.log();
  info("=== Validation Report ===");
  console.log();

  let anyFailed = false;
  for (const result of results) {
    if (result.pass) {
      ok(`${result.name}: ${result.detail}`);
    } else {
      error(`${result.name}: ${result.detail}`);
      anyFailed = true;
    }
  }

  console.log();
  if (anyFailed) {
    error(
      "Validation failed — fix the issues above before running bun run start.",
    );
    process.exit(1);
  } else {
    ok("All checks passed — ready to run bun run start.");
    process.exit(0);
  }
}
