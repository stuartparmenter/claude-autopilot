# Adding a Project

This guide walks you through onboarding a new project repository for claude-autopilot. By the end, the executor will be able to pick up Linear issues, implement them, and open PRs against your project.

---

## Prerequisites

Before starting, make sure you have:

- **Bun** installed (https://bun.sh)
- **A git repository** for the project you want to onboard
- **A Linear account** with a team set up for the project
- **A Linear API key** (create one at https://linear.app/settings/api)
- **Claude Code authenticated** (the Agent SDK uses your existing auth)

---

## Step 1: Run the Setup Script

From the claude-autopilot directory, run:

```bash
bun run setup /path/to/your/project
```

This script does the following:

1. Verifies that the target path is a git repository
2. Copies `CLAUDE.md` from the template into your project (if it does not already exist)
3. Copies `.claude-autopilot.yml` config into your project (if it does not already exist)
4. Creates `.claude/settings.json` with Agent Teams enabled and Linear MCP configured
5. Adds `.claude-autopilot.yml` to `.gitignore` (it contains local config and should not be committed)

### What to expect

```
[INFO] Checking prerequisites...
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
| "not a git repository" | Run `git init` in your project directory first |
| "CLAUDE.md already exists, skipping" | This is fine. Delete the existing file and re-run if you want a fresh template |
| ".claude-autopilot.yml already exists, skipping" | Same as above. Delete and re-run to get the default template |

---

## Step 2: Fill in CLAUDE.md

`CLAUDE.md` is the most important file in the setup. It is the context document that every Claude Code agent reads when working on your project. The quality of the executor's output is directly proportional to the quality of this file.

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

The autopilot requires the **Triage** issue status to be enabled in Linear. It is off by default on new teams. Enable it under Settings → [Your Team] → Issue statuses & automations → Triage.

Map the state names to match your Linear workflow:

```yaml
linear:
  team: "ENG"
  project: "my-project"
  states:
    triage: "Triage"           # Where auditor files new issues (enable this in Linear)
    ready: "Todo"              # Where executor picks up issues
    in_progress: "In Progress" # Set by executor while working
    done: "Done"               # Set by executor on success
    blocked: "Backlog"         # Set by executor on failure/timeout
```

The state names must match your Linear workflow exactly (case-sensitive).

### Executor settings

```yaml
executor:
  parallel: 3                           # Max concurrent executor agents
  timeout_minutes: 30                   # Kill executor after this long
  model: "sonnet"                       # Model for executor agents
  planning_model: "opus"                # Model for auditor/planning
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
  model: "sonnet"
  planning_model: "opus"
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

The `LINEAR_API_KEY` is used by both the orchestrator scripts (via `@linear/sdk`) and the Claude Code agents (via the Linear MCP server). A single API key handles both.

1. Go to https://linear.app/settings/api
2. Create a new personal API key (or a workspace-level key for shared use)
3. Set the environment variable:

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For persistent use, add this to your shell profile (`~/.bashrc`, `~/.zshrc`) or use a secrets manager.

The setup script configures the Linear MCP server in `.claude/settings.json` to pass this key automatically via the `Authorization: Bearer` header — no separate OAuth flow is needed.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| "LINEAR_API_KEY environment variable is not set" | Make sure the variable is exported in the shell session running the script |
| "Linear connection failed" | Verify the key is valid and not expired |
| "Team 'XYZ' not found in Linear" | The `linear.team` value in config must be the team **key** (e.g., "ENG"), not the team name (e.g., "Engineering"). Find it in your Linear team settings URL |
| "State 'Todo' not found for team" | The state names in `linear.states` must exactly match your Linear workflow state names. Check Linear team settings for the exact names |
| Agent can't file Linear issues | Verify `LINEAR_API_KEY` is exported in the shell where you run `bun run start`. The MCP server inherits it from the environment |

---

## Step 5: Start the Loop

Once configuration is complete, start the loop:

```bash
bun run start /path/to/your/project
```

This will:
1. Connect to Linear and resolve team/state IDs
2. Start the web dashboard at http://localhost:7890
3. Begin polling for Ready issues and filling executor slots
4. Run the auditor when the backlog drops below threshold

Open the dashboard in your browser to watch agents work in real time.

### Custom port

```bash
bun run start /path/to/your/project --port 3000
```

---

## Summary Checklist

Use this checklist to verify your setup:

- [ ] `bun run setup /path/to/project` completed successfully
- [ ] `CLAUDE.md` filled in with project details (architecture, commands, conventions)
- [ ] `.claude-autopilot.yml` configured (team key, project name at minimum)
- [ ] `LINEAR_API_KEY` environment variable set
- [ ] `bun run start /path/to/project` starts successfully and shows dashboard
- [ ] Dashboard accessible at http://localhost:7890
