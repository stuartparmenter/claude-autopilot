#!/usr/bin/env bun

/**
 * setup-project.ts - Onboard a new project repository for claude-autopilot
 *
 * Usage: bun run setup <project-path>
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { error, header, info, ok, warn } from "./lib/logger";

const AUTOPILOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const projectPath = process.argv[2];
if (!projectPath) {
  console.log("Usage: bun run setup <project-path>");
  console.log();
  console.log("Onboard a project repository for claude-autopilot.");
  console.log(
    "This will set up the necessary config files and Claude Code settings.",
  );
  process.exit(1);
}

const PROJECT_PATH = resolve(projectPath);

if (!existsSync(PROJECT_PATH)) {
  error(`Project path does not exist: ${PROJECT_PATH}`);
}

// --- Check prerequisites ---

info("Checking prerequisites...");

// Check it's a git repo
const gitCheck = Bun.spawnSync(
  ["git", "-C", PROJECT_PATH, "rev-parse", "--is-inside-work-tree"],
  {
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (gitCheck.exitCode !== 0) {
  error(
    `${PROJECT_PATH} is not a git repository. Initialize with 'git init' first.`,
  );
}
ok(`${PROJECT_PATH} is a git repository`);

// --- Copy CLAUDE.md template ---

info("Setting up project files...");

const claudeMdPath = resolve(PROJECT_PATH, "CLAUDE.md");
if (existsSync(claudeMdPath)) {
  warn("CLAUDE.md already exists, skipping (delete it to regenerate)");
} else {
  const template = readFileSync(
    resolve(AUTOPILOT_ROOT, "templates/CLAUDE.md.template"),
    "utf-8",
  );
  writeFileSync(claudeMdPath, template);
  ok("Created CLAUDE.md -fill this in with your project details");
}

// --- Copy config template ---

const configPath = resolve(PROJECT_PATH, ".claude-autopilot.yml");
if (existsSync(configPath)) {
  warn(
    ".claude-autopilot.yml already exists, skipping (delete it to regenerate)",
  );
} else {
  const template = readFileSync(
    resolve(AUTOPILOT_ROOT, "templates/claude-autopilot.yml.template"),
    "utf-8",
  );
  writeFileSync(configPath, template);
  ok("Created .claude-autopilot.yml -fill this in with your project config");
}

// --- Set up .claude/settings.json ---

const claudeDir = resolve(PROJECT_PATH, ".claude");
const settingsPath = resolve(claudeDir, "settings.json");

mkdirSync(claudeDir, { recursive: true });

if (existsSync(settingsPath)) {
  warn(".claude/settings.json already exists");

  const existing = readFileSync(settingsPath, "utf-8");

  if (existing.includes("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")) {
    ok("Agent Teams already configured");
  } else {
    warn("Agent Teams flag not found -you may need to add it manually");
    warn(
      'Add to .claude/settings.json: "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }',
    );
  }

  if (existing.includes("mcp.linear.app")) {
    ok("Linear MCP already configured");
  } else {
    warn("Linear MCP not found -you may need to add it manually");
    warn("See .claude/settings.json in the autopilot repo for the config");
  }
} else {
  const settings = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
    mcpServers: {
      linear: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          "https://mcp.linear.app/mcp",
          "--header",
          "Authorization: Bearer ${LINEAR_API_KEY}",
        ],
      },
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  ok("Created .claude/settings.json with Linear MCP and Agent Teams");
}

// --- Add to .gitignore ---

const gitignorePath = resolve(PROJECT_PATH, ".gitignore");
if (existsSync(gitignorePath)) {
  const existing = readFileSync(gitignorePath, "utf-8");
  if (!existing.includes(".claude-autopilot.yml")) {
    appendFileSync(
      gitignorePath,
      "\n# claude-autopilot local config\n.claude-autopilot.yml\n",
    );
    ok("Added .claude-autopilot.yml to .gitignore");
  }
} else {
  writeFileSync(
    gitignorePath,
    "# claude-autopilot local config\n.claude-autopilot.yml\n",
  );
  ok("Created .gitignore with .claude-autopilot.yml");
}

// --- Print next steps ---

header("Project onboarded successfully!");

console.log("Next steps:");
console.log();
console.log("  1. Fill in your project details in CLAUDE.md");
console.log(
  "     This is the most important file -it tells Claude about your project.",
);
console.log(`     ${claudeMdPath}`);
console.log();
console.log("  2. Configure .claude-autopilot.yml");
console.log("     Set your Linear team, project, commands, and preferences.");
console.log(`     ${configPath}`);
console.log();
console.log("  3. Set your Linear API key");
console.log("     export LINEAR_API_KEY=lin_api_...");
console.log("     Get one at: https://linear.app/settings/api");
console.log("     The Linear MCP uses this key automatically (no OAuth needed).");
console.log();
console.log("  4. Start the loop");
console.log(`     bun run start ${PROJECT_PATH}`);
console.log("     Dashboard at http://localhost:7890");
console.log();
