#!/usr/bin/env bun

/**
 * test-loop.ts — Create test issues in Linear and validate the executor
 *
 * Usage: bun run test-loop <project-path>
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkClaudeCli } from "./lib/claude";
import { loadConfig, resolveProjectPath } from "./lib/config";
import {
  createIssue,
  findOrCreateLabel,
  resolveLinearIds,
  testConnection,
} from "./lib/linear";
import { error, header, info, ok, warn } from "./lib/logger";

const projectPath = resolveProjectPath(process.argv[2]);
const config = loadConfig(projectPath);

if (!config.linear.team)
  error("linear.team is not set in .claude-autopilot.yml");

header("claude-autopilot Test Loop");

info(`Project: ${projectPath}`);
info(`Linear team: ${config.linear.team}`);
info(`Ready state: ${config.linear.states.ready}`);
console.log();

// --- Pre-flight checks ---

info("Checking prerequisites...");

if (!(await checkClaudeCli())) {
  error("claude CLI not found");
}
ok("claude CLI available");

const settingsPath = resolve(projectPath, ".claude/settings.json");
if (!existsSync(settingsPath)) {
  error(".claude/settings.json not found. Run 'bun run setup' first.");
}
ok(".claude/settings.json exists");

const claudeMdPath = resolve(projectPath, "CLAUDE.md");
if (!existsSync(claudeMdPath)) {
  warn("CLAUDE.md not found — the executor will have limited project context");
}

// --- Test Linear connection ---

console.log();
info("Testing Linear API connection...");

if (!(await testConnection())) {
  error("Linear connection failed. Set LINEAR_API_KEY environment variable.");
}
ok("Linear API connection working");

// Resolve IDs
info("Resolving Linear team and states...");
const linearIds = await resolveLinearIds(config.linear);
ok(`Team: ${config.linear.team} → ${linearIds.teamId}`);

// --- Create labels ---

info("Ensuring labels exist...");
const [autoAuditLabel, codeQualityLabel, docLabel, lowLabel] =
  await Promise.all([
    findOrCreateLabel(linearIds.teamId, "auto-audit", "#888888"),
    findOrCreateLabel(linearIds.teamId, "code-quality", "#06b6d4"),
    findOrCreateLabel(linearIds.teamId, "documentation", "#84cc16"),
    findOrCreateLabel(linearIds.teamId, "low", "#888888"),
  ]);
ok("Labels ready");

// --- Create test issues ---

console.log();
info("Creating 3 test issues in Linear...");
console.log();

const testIssues = [
  {
    title: "Add .editorconfig for consistent formatting",
    description: `## Context
The project lacks an .editorconfig file, which means different editors may use different formatting settings.

## Implementation Plan
1. Create a \`.editorconfig\` file in the project root with standard settings:
   - root = true
   - indent_style = space
   - indent_size = 2 for JS/TS/JSON/YAML files, 4 for Python
   - end_of_line = lf
   - charset = utf-8
   - trim_trailing_whitespace = true
   - insert_final_newline = true

## Acceptance Criteria
- [ ] .editorconfig file exists in project root
- [ ] File contains settings for at least JS/TS and Python file types
- [ ] File sets indent_style, indent_size, end_of_line, and charset

## Estimate
S`,
    priority: 4,
    labels: [autoAuditLabel.id, codeQualityLabel.id, lowLabel.id],
  },
  {
    title: "Add a comment explaining the main entry point",
    description: `## Context
The main entry point of the application could use a brief comment explaining what it does and how to run it.

## Implementation Plan
1. Identify the main entry point file
2. Add a brief comment block at the top explaining:
   - What this file does
   - How to run it

## Acceptance Criteria
- [ ] Main entry point file has a comment block at the top
- [ ] Comment explains the purpose of the file
- [ ] Comment includes how to run the application

## Estimate
S`,
    priority: 4,
    labels: [autoAuditLabel.id, docLabel.id, lowLabel.id],
  },
  {
    title: "Verify README has installation instructions",
    description: `## Context
Every project should have clear installation instructions in the README.

## Implementation Plan
1. Check if README.md exists and has an installation/setup section
2. If missing, add an "Installation" or "Getting Started" section with:
   - Prerequisites
   - Install command (npm install, pip install, etc.)
   - How to run the dev server or main script

## Acceptance Criteria
- [ ] README.md exists
- [ ] README.md contains an installation or setup section
- [ ] Section includes at least one command to install dependencies

## Estimate
S`,
    priority: 4,
    labels: [autoAuditLabel.id, docLabel.id, lowLabel.id],
  },
];

const createdIssues: Array<{ identifier: string; title: string }> = [];

for (const testIssue of testIssues) {
  const issue = await createIssue({
    teamId: linearIds.teamId,
    title: testIssue.title,
    description: testIssue.description,
    stateId: linearIds.states.ready,
    priority: testIssue.priority,
    labelIds: testIssue.labels,
  });
  createdIssues.push({ identifier: issue.identifier, title: testIssue.title });
  ok(`Created: ${issue.identifier} — ${testIssue.title}`);
}

// --- Run executor for one issue ---

console.log();
info("Running the executor to process one test issue...");
console.log();

// Spawn the executor as a subprocess
const executorProc = Bun.spawn(
  ["bun", "run", "src/executor.ts", projectPath, "once"],
  {
    cwd: resolve(import.meta.dirname ?? ".", ".."),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);

await executorProc.exited;

// --- Summary ---

header("Test Loop Complete");

console.log("Check the following:");
console.log();
console.log("  1. Linear: Are the test issues updated?");
for (const issue of createdIssues) {
  console.log(`     - ${issue.identifier}: ${issue.title}`);
}
console.log();
console.log("  2. Git: Check for new branches");
console.log("     git branch -a | grep autopilot");
console.log();
console.log("  3. Code: Review the changes");
console.log("     git log --oneline -5");
console.log();
console.log(
  "If the first issue was executed successfully, your setup is working!",
);
console.log("Run the remaining issues with:");
console.log(`  bun run executor ${projectPath} loop`);
console.log();
