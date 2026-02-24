# Adding a Project

This guide walks you through onboarding a new project repository for claude-autopilot. By the end, the executor will be able to pick up Linear issues, implement them, and open PRs against your project.

---

## Prerequisites

Before starting, make sure you have:

- **Bun** installed (https://bun.sh)
- **Claude Code CLI** installed and authenticated (https://docs.anthropic.com/en/docs/claude-code)
- **A git repository** for the project you want to onboard
- **A Linear account** with a team set up for the project
- **A Linear API key** (create one at https://linear.app/settings/api)

---

## Step 1: Run the Setup Script

From the claude-autopilot directory, run:

```bash
bun run setup /path/to/your/project
```

This script does the following:

1. Verifies that the `claude` CLI is installed
2. Verifies that the target path is a git repository
3. Copies `CLAUDE.md` from the template into your project (if it does not already exist)
4. Copies `.claude-autopilot.yml` config into your project (if it does not already exist)
5. Creates `.claude/settings.json` with Agent Teams enabled and Linear MCP configured
6. Adds `.claude-autopilot.yml` to `.gitignore` (it contains local config and should not be committed)

### What to expect

```
[INFO] Checking prerequisites...
[OK]   claude CLI found
[OK]   /path/to/your/project is a git repository
[INFO] Setting up project files...
[OK]   Created CLAUDE.md — fill this in with your project details
[OK]   Created .claude-autopilot.yml — fill this in with your project config
[OK]   Created .claude/settings.json with Linear MCP and Agent Teams
[OK]   Added .claude-autopilot.yml to .gitignore

=== Project onboarded successfully! ===
```

### Troubleshooting

| Problem | Solution |
|---------|----------|
| "claude CLI not found" | Install Claude Code: `npm install -g @anthropic-ai/claude-code` |
| "not a git repository" | Run `git init` in your project directory first |
| "CLAUDE.md already exists, skipping" | This is fine. Delete the existing file and re-run if you want a fresh template |
| ".claude-autopilot.yml already exists, skipping" | Same as above. Delete and re-run to get the default template |

---

## Step 2: Fill in CLAUDE.md

`CLAUDE.md` is the most important file in the setup. It is the context document that every Claude Code instance reads when working on your project. The quality of the executor's output is directly proportional to the quality of this file.

Open `CLAUDE.md` in your project and fill in every section. The template has placeholder text in `[brackets]` and HTML comments with guidance.

### What matters most

**Architecture section.** The executor needs to understand where things live. List your services, components, databases, and how they connect. If you have a monorepo, explain the package structure.

**Development Commands section.** The executor will run your test and lint commands. If these are wrong, every issue will fail validation. Be precise:

```bash
# Good: exact command the executor should run
npm test -- --watchAll=false

# Bad: command that requires interactive input
npm test
```

**Code Conventions section.** The executor follows existing patterns in the codebase, but explicit conventions help it make better decisions. Especially important:
- Import ordering and style
- Error handling patterns
- Naming conventions
- Test file placement and naming

**Things to Watch Out For section.** This is where you document the gotchas that trip people up. If there is a soft-delete column that must always be filtered, put it here. If an environment variable must be set in test mode, put it here. The executor will read this before every implementation.

### Tips

- Be specific. "Tests use Jest" is less helpful than "Tests use Jest with `ts-jest` transform. Test files are colocated with source files as `*.test.ts`. Fixtures are in `tests/fixtures/`. Use `factories.ts` for test data, not inline object literals."
- Include examples. Showing a 5-line code snippet of "how we do error handling" is more effective than a paragraph describing it.
- Update it over time. When the executor makes a mistake that better context would have prevented, add that context to CLAUDE.md.

---

## Step 3: Fill in .claude-autopilot.yml

This is the configuration file that controls how claude-autopilot interacts with your project. Open `.claude-autopilot.yml` in your project and configure each section.

### Required fields

These fields must be set. The executor will refuse to run without them:

```yaml
linear:
  team: "ENG"          # Your Linear team key (visible in team settings URL)

project:
  name: "my-project"   # Human-readable project name
```

### Critical fields

These fields are technically optional (they have defaults), but getting them right is critical for executor success:

```yaml
project:
  test_command: "npm test -- --watchAll=false"   # Must run non-interactively and exit
  lint_command: "npm run lint"                    # Must run non-interactively and exit
  build_command: "npm run build"                  # Optional, used for validation
  tech_stack: "TypeScript, Next.js, PostgreSQL, Prisma"  # Included in prompts
```

**test_command and lint_command are the most important settings after `linear.team`.** The executor runs these commands to validate its implementation. If they are wrong, the executor will either skip validation (no command configured) or get stuck in a loop trying to fix unrelated failures.

Requirements for these commands:
- Must run non-interactively (no prompts, no watch mode)
- Must exit with code 0 on success and non-zero on failure
- Must be runnable from the project root directory

### Linear state mapping

If your Linear workflow uses non-default state names, map them here:

```yaml
linear:
  team: "ENG"
  project: "my-project"        # Optional: Linear project name for filtering
  states:
    triage: "Triage"           # Where auditor files new issues
    ready: "Todo"              # Where executor picks up issues
    in_progress: "In Progress" # Set by executor while working
    done: "Done"               # Set by executor on success
    blocked: "Backlog"         # Set by executor on failure/timeout
```

The state names must match your Linear workflow exactly (case-sensitive).

### Executor settings

```yaml
executor:
  parallel: 3                           # Max concurrent executor instances (n8n only)
  timeout_minutes: 30                   # Kill executor after this long
  auto_approve_labels: []               # Labels that skip human PR review (Phase 3)
  branch_pattern: "autopilot/{{id}}"    # Git branch naming pattern
  commit_pattern: "{{id}}: {{title}}"   # Commit message pattern
```

### Auditor settings

```yaml
auditor:
  schedule: "when_idle"         # when_idle | daily | manual
  min_ready_threshold: 5        # Only audit if Ready count < this
  max_issues_per_run: 10        # Cap on issues filed per audit
  use_agent_teams: true         # Use Planner/Verifier/Security subagents
  scan_dimensions:              # What the auditor looks for
    - test-coverage
    - error-handling
    - performance
    - security
    - code-quality
    - dependency-health
    - documentation
```

### Protected paths

Files the executor must never modify:

```yaml
project:
  protected_paths:
    - ".env"
    - ".claude-autopilot.yml"
    - "CLAUDE.md"
```

Add any files that should be off-limits to automation (CI config, deploy scripts, etc.).

### Full example

```yaml
linear:
  team: "ENG"
  project: "acme-api"
  states:
    triage: "Triage"
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    blocked: "Backlog"

executor:
  parallel: 3
  timeout_minutes: 30
  auto_approve_labels: []
  branch_pattern: "autopilot/{{id}}"
  commit_pattern: "{{id}}: {{title}}"

auditor:
  schedule: "when_idle"
  min_ready_threshold: 5
  max_issues_per_run: 10
  use_agent_teams: true
  scan_dimensions:
    - test-coverage
    - error-handling
    - performance
    - security
    - code-quality
    - dependency-health
    - documentation

project:
  name: "acme-api"
  tech_stack: "TypeScript, Express, PostgreSQL, Prisma, Jest"
  test_command: "npm test -- --watchAll=false --forceExit"
  lint_command: "npm run lint"
  build_command: "npm run build"
  key_directories:
    - "src/api"
    - "src/services"
    - "src/models"
  protected_paths:
    - ".env"
    - ".env.local"
    - ".claude-autopilot.yml"
    - "CLAUDE.md"
    - ".github/workflows"

notifications:
  slack_webhook: "https://hooks.slack.com/services/T.../B.../..."
  notify_on:
    - executor_complete
    - executor_blocked
    - auditor_complete
    - error
```

---

## Step 4: Set LINEAR_API_KEY

The executor and auditor scripts use the Linear SDK (`@linear/sdk`) to query and update issues. This requires an API key.

1. Go to https://linear.app/settings/api
2. Create a new personal API key (or a workspace-level key for shared use)
3. Set the environment variable:

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For persistent use, add this to your shell profile (`~/.bashrc`, `~/.zshrc`) or use a secrets manager.

For n8n deployments, set `LINEAR_API_KEY` as an environment variable in your n8n instance.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| "LINEAR_API_KEY environment variable is not set" | Make sure the variable is exported in the shell session running the script |
| "Linear connection failed" | Verify the key is valid and not expired. Try `curl -H "Authorization: lin_api_..." https://api.linear.app/graphql` |
| "Team 'XYZ' not found in Linear" | The `linear.team` value in config must be the team **key** (e.g., "ENG"), not the team name (e.g., "Engineering"). Find it in your Linear team settings URL |
| "State 'Todo' not found for team" | The state names in `linear.states` must exactly match your Linear workflow state names. Check Linear team settings for the exact names |

---

## Step 5: Authenticate Linear MCP

The Claude Code agents (both executor and auditor) use the Linear MCP server to read and update issues directly. This requires a separate authentication step.

1. Open a terminal in your project directory
2. Run `claude` to start an interactive Claude Code session
3. Type `/mcp` to open the MCP management interface
4. You should see the Linear MCP server listed (set up by the setup script)
5. Follow the authentication flow -- this will open a browser window for Linear OAuth

After authenticating, the Linear MCP will be available to all Claude Code instances running in your project directory.

### How the setup script configured MCP

The setup script created `.claude/settings.json` with:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    }
  }
}
```

The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag enables Agent Teams, which the auditor uses for its Planner/Verifier/Security Reviewer subagents.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Linear MCP not listed in `/mcp` | Check that `.claude/settings.json` exists and contains the `mcpServers.linear` entry |
| Authentication fails | Make sure your Linear account has access to the team specified in config |
| "Agent Teams flag not found" | Add `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` to the `env` section of `.claude/settings.json` |
| MCP works interactively but not in headless mode | Ensure the MCP auth tokens are stored at the project level, not the user level. Re-authenticate from the project directory |

---

## Step 6: Validate with test-loop

The test-loop script creates sample issues in Linear and runs the executor on one of them. This validates the entire pipeline end-to-end.

```bash
bun run test-loop /path/to/your/project
```

### What it does

1. **Pre-flight checks**: Verifies `claude` CLI, `.claude/settings.json`, `CLAUDE.md`, and Linear API connection
2. **Resolves Linear IDs**: Confirms team and state mappings are correct
3. **Creates labels**: Ensures `auto-audit`, `code-quality`, `documentation`, and `low` labels exist in your team
4. **Creates 3 test issues** in the Ready state:
   - "Add .editorconfig for consistent formatting"
   - "Add a comment explaining the main entry point"
   - "Verify README has installation instructions"
5. **Runs the executor** in `once` mode to process the first test issue
6. **Prints a checklist** of things to verify

### What to check after

1. **Linear**: Are the test issues visible? Did the first one move to Done or Blocked?
2. **Git**: Run `git branch -a | grep autopilot` to see if a branch was created
3. **GitHub**: Was a PR opened? Does it look reasonable?
4. **Code**: Run `git log --oneline -5` to see if a commit was made

### Expected output

```
=== claude-autopilot Test Loop ===

[INFO] Project: /path/to/your/project
[INFO] Linear team: ENG
[INFO] Ready state: Todo

[INFO] Checking prerequisites...
[OK]   claude CLI available
[OK]   .claude/settings.json exists

[INFO] Testing Linear API connection...
[OK]   Linear API connection working

[INFO] Resolving Linear team and states...
[OK]   Team: ENG → <team-id>

[INFO] Ensuring labels exist...
[OK]   Labels ready

[INFO] Creating 3 test issues in Linear...

[OK]   Created: ENG-42 — Add .editorconfig for consistent formatting
[OK]   Created: ENG-43 — Add a comment explaining the main entry point
[OK]   Created: ENG-44 — Verify README has installation instructions

[INFO] Running the executor to process one test issue...
...
```

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Pre-flight checks fail | Go back to the relevant step above and fix the issue |
| Issues created but executor fails | Check the executor output for error details. Common causes: bad test/lint command, missing MCP auth, missing CLAUDE.md |
| Executor runs but issue stays in Ready | The executor may have failed silently. Check `git branch -a` for a worktree branch. Check Linear issue comments for error details |
| Executor completes but PR is not created | Claude may have implemented the change but failed at the push/PR step. Check that the git remote is configured and you have push access |
| Everything works but the code quality is poor | Improve your `CLAUDE.md`. The more context you give Claude about your project, the better its output |

---

## Step 7: Run the Executor

Once validation passes, you can run the executor in two modes.

### One-shot mode

Process a single issue and exit:

```bash
bun run executor /path/to/your/project once
```

This is useful for testing or for running the executor manually on specific issues. The executor picks the highest-priority Ready issue that is not blocked.

### Loop mode

Continuously process issues until none remain:

```bash
bun run executor /path/to/your/project loop
```

In loop mode, the executor:
1. Picks the next Ready unblocked issue
2. Executes it (spawns Claude in a worktree)
3. Waits 60 seconds if no issues are found
4. Stops after 3 consecutive empty/error cycles

### Running the auditor

To scan the codebase and file improvement issues:

```bash
bun run auditor /path/to/your/project
```

The auditor checks the backlog threshold first. If there are already enough Ready issues (`>= min_ready_threshold`), it exits immediately without scanning.

### Setting up n8n (Phase 2)

For automated, scheduled execution:

1. Import the workflow templates from the `n8n/` directory into your n8n instance
2. Configure the workflow with your project path and environment variables
3. Set the cron schedule (recommended: every 5 minutes for executor, every 6 hours for auditor)
4. Adjust parallelism in `.claude-autopilot.yml` (`executor.parallel`)

---

## Summary Checklist

Use this checklist to verify your setup:

- [ ] `bun run setup /path/to/project` completed successfully
- [ ] `CLAUDE.md` filled in with project details (architecture, commands, conventions)
- [ ] `.claude-autopilot.yml` configured (team key, test/lint commands at minimum)
- [ ] `LINEAR_API_KEY` environment variable set
- [ ] Linear MCP authenticated (ran `claude` then `/mcp` in project directory)
- [ ] `bun run test-loop /path/to/project` completed successfully
- [ ] Test issue was executed (moved to Done in Linear, branch created, PR opened)
- [ ] Remaining test issues cleaned up in Linear (or run executor in loop mode to process them)
