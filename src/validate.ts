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
import { error, header, info, ok, warn } from "./lib/logger";
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
 * LINEAR_API_KEY or OAuth must be configured, GITHUB_TOKEN is required.
 * Note: ANTHROPIC_API_KEY is checked separately by checkAnthropicAuth()
 * because the Agent SDK can inherit auth from a Claude Code subscription,
 * making it a soft warning rather than a hard requirement.
 */
export async function checkEnvVars(opts?: {
  hasOAuth?: boolean;
}): Promise<string> {
  const missing: string[] = [];
  if (!process.env.LINEAR_API_KEY && !opts?.hasOAuth)
    missing.push("LINEAR_API_KEY (or configure OAuth)");
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  const linearAuth = process.env.LINEAR_API_KEY
    ? "LINEAR_API_KEY"
    : "Linear OAuth";
  return `${linearAuth}, GITHUB_TOKEN — all set`;
}

/**
 * Check 2b: Check for Anthropic API key (non-blocking).
 * The Agent SDK can inherit auth from a Claude Code subscription plan,
 * so a missing key is a warning, not a hard failure. Agents will fail at
 * runtime if there is truly no auth available.
 */
export async function checkAnthropicAuth(): Promise<string> {
  const hasKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_USE_BEDROCK ||
    process.env.CLAUDE_CODE_USE_VERTEX;
  if (!hasKey) {
    throw new Error(
      "No ANTHROPIC_API_KEY or CLAUDE_API_KEY found. " +
        "If using Claude Code subscription auth, this is fine. " +
        "Otherwise, set: export ANTHROPIC_API_KEY=sk-ant-...",
    );
  }
  return "ANTHROPIC_API_KEY — set";
}

/**
 * Check 3: Verify the clone base directory is writable.
 * Creates the directory if absent, then writes and removes a test file.
 */
export async function checkCloneDir(projectPath: string): Promise<string> {
  const cloneBase = resolve(projectPath, ".claude", "clones");
  mkdirSync(cloneBase, { recursive: true });
  const testFile = resolve(cloneBase, `.validate-${Date.now()}`);
  writeFileSync(testFile, "validate");
  rmSync(testFile);
  return `${cloneBase} is writable`;
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
 * Also checks for any project-local overrides at <projectPath>/.autopilot/prompts/.
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

/**
 * Check 7: Verify the git remote is configured and parseable.
 * Runs without requiring GITHUB_TOKEN — useful for setup validation.
 */
export async function checkGitRemote(
  projectPath: string,
  config?: { github?: { repo?: string } },
): Promise<string> {
  const { owner, repo } = detectRepo(
    projectPath,
    config?.github?.repo || undefined,
  );
  return `${owner}/${repo}`;
}

/**
 * Check 8: Verify the GitHub token has the required `repo` scope.
 * Checks the `x-oauth-scopes` response header from the authenticated user API.
 * Fine-grained tokens do not include this header — those are treated as acceptable.
 */
export async function checkGitHubPermissions(): Promise<string> {
  const octokit = getGitHubClient();
  const response = await withRetry(
    () => octokit.rest.users.getAuthenticated(),
    "checkGitHubPermissions",
  );
  const scopeHeader = response.headers["x-oauth-scopes"];
  if (!scopeHeader) {
    return `Authenticated as ${response.data.login} (fine-grained token, scope check skipped)`;
  }
  const scopes = scopeHeader.split(",").map((s: string) => s.trim());
  if (!scopes.includes("repo")) {
    throw new Error(
      `Token missing required 'repo' scope. ` +
        `Token has scopes: ${scopeHeader}. ` +
        `Create a new token at https://github.com/settings/tokens with the 'repo' scope enabled.`,
    );
  }
  return `Token has scopes: ${scopeHeader}`;
}

// --- CLI entry point ---

export interface CheckResult {
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

/**
 * Run all preflight checks for the system to function.
 * Runs every check regardless of earlier failures and returns a summary.
 * Non-blocking checks (like Anthropic auth) are returned as warnings.
 * Intended for use in main.ts before starting the main loop.
 */
export async function runPreflight(
  projectPath: string,
  config: AutopilotConfig,
): Promise<{
  passed: boolean;
  results: CheckResult[];
  warnings: CheckResult[];
}> {
  const hasOAuth = !!config.linear.oauth;
  const checks: Array<[string, () => Promise<string>]> = [
    ["Environment variables", () => checkEnvVars({ hasOAuth })],
    ["Git remote", () => checkGitRemote(projectPath, config)],
    ["Clone directory", () => checkCloneDir(projectPath)],
    ["Linear connection", () => checkLinear(config)],
    ["GitHub connection", () => checkGitHub(projectPath, config)],
  ];

  const results: CheckResult[] = [];
  for (const [name, fn] of checks) {
    results.push(await runCheck(name, fn));
  }

  // Non-blocking checks — failures here are warnings, not fatal errors.
  // Anthropic auth can be inherited from a Claude Code subscription plan.
  const warnChecks: Array<[string, () => Promise<string>]> = [
    ["Anthropic auth", () => checkAnthropicAuth()],
  ];

  const warnings: CheckResult[] = [];
  for (const [name, fn] of warnChecks) {
    warnings.push(await runCheck(name, fn));
  }

  return { passed: results.every((r) => r.pass), results, warnings };
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

  header("autopilot validate");
  info(`Project: ${projectPath}`);
  console.log();

  // Load config once for checks that need it (Linear, GitHub)
  let config: AutopilotConfig | null = null;
  try {
    config = loadConfig(projectPath);
  } catch {
    // Config failure is captured in the checkConfig result below
  }

  const hasOAuth = !!config?.linear.oauth;
  const checks: Array<[string, () => Promise<string>]> = [
    ["Config", () => checkConfig(projectPath)],
    ["Environment variables", () => checkEnvVars({ hasOAuth })],
    ["Clone directory", () => checkCloneDir(projectPath)],
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

  // Non-blocking checks — failures are warnings, not errors
  const warnChecks: Array<[string, () => Promise<string>]> = [
    ["Anthropic auth", () => checkAnthropicAuth()],
  ];

  const results: CheckResult[] = [];
  for (const [name, fn] of checks) {
    results.push(await runCheck(name, fn));
  }

  const warnings: CheckResult[] = [];
  for (const [name, fn] of warnChecks) {
    warnings.push(await runCheck(name, fn));
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
  for (const result of warnings) {
    if (result.pass) {
      ok(`${result.name}: ${result.detail}`);
    } else {
      warn(`${result.name}: ${result.detail}`);
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
