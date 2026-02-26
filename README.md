# claude-autopilot

A self-sustaining AI development loop using **Claude Code** + **Linear**.

Three automated loops keep your project moving forward:

```
┌─────────────────────────────────────────────────────────────────┐
│                        EXECUTOR LOOP                            │
│                                                                 │
│  Linear (Ready) ──→ Claude Code ──→ Tests ──→ PR ──→ Linear    │
│       ↑              (worktree)      pass?     ✓    (In Review) │
│       │                               │                         │
│       │                               ✗                         │
│       │                               ↓                         │
│       │                          Linear (Blocked)               │
│       │                                                         │
│  Human reviews Triage ──→ promotes to Ready                     │
│       ↑                                                         │
│       │                                                         │
│  Linear (Triage) ←── Claude Code ←── Codebase scan             │
│                       (Agent Team)                              │
│                       (CTO Agent Team)                          │
│                       ├─ Scout                                  │
│                       ├─ Security Analyst                       │
│                       ├─ Quality Engineer                       │
│                       └─ Architect                              │
│                                                                 │
│                        PLANNING LOOP                            │
│                                                                 │
│  Linear (In Review) ──→ Check PR ──→ CI failed? ──→ Fixer      │
│                                      Conflict?       (worktree) │
│                                         │               │       │
│                                         ✗               ↓       │
│                                        skip       Push fix to   │
│                                                   existing PR   │
│                                                                 │
│                        MONITOR LOOP                             │
└─────────────────────────────────────────────────────────────────┘
```

**Executor**: Pulls unblocked "Ready" issues from Linear, spawns Claude Code agents in isolated git worktrees, implements the change, runs tests, pushes a PR, and updates Linear. Runs multiple agents in parallel.

**Monitor**: Watches issues in "In Review" state. Checks their linked GitHub PRs for CI failures and merge conflicts. Spawns fixer agents to repair problems automatically. If a fix can't be applied after 3 attempts, moves the issue to "Blocked" for human attention.

**Planning**: When the backlog runs low, scans the codebase for improvements. Uses a CTO agent that leads a team of specialists (Scout, Security Analyst, Quality Engineer, Architect) and spawns Issue Planner subagents to produce well-planned issues filed to "Triage" for human review.

**Dashboard**: A web UI shows live agent activity, execution history, and queue status.

**You**: Review Triage, promote good issues to Ready, review PRs, and the loop continues.

## Security Notice

claude-autopilot runs Claude Code agents with **`bypassPermissions`** mode, which gives agents unrestricted access to read/write files and execute shell commands. To mitigate this, **OS-level sandboxing is enabled by default** — each agent's bash commands are isolated to its worktree directory, and sandbox escape is hardcoded off (`allowUnsandboxedCommands: false`).

**Sandbox prerequisites:**
- **Linux / WSL2**: `sudo apt-get install bubblewrap socat`
- **macOS**: The Agent SDK uses its own sandbox mechanism (no extra packages needed)

If bubblewrap/socat are not installed on Linux, the SDK may silently fall back to no sandboxing. You can disable the sandbox in `.claude-autopilot.yml` (`sandbox.enabled: false`), but this means agents have unrestricted filesystem access — only do this if you're running in an already-isolated environment.

**Additional recommendations:**
- Run in a **container or VM** for defense in depth, even with sandboxing enabled
- Use **git worktrees** (the default) so agents work on branches, not main
- Review all PRs before merging — the human review step is your safety net
- Enable `sandbox.network_restricted: true` to limit agents to only GitHub and Linear APIs
- Start with `executor.parallel: 1` and watch the dashboard closely before scaling up

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Linear](https://linear.app) account with API key
- [GitHub](https://github.com/settings/tokens) personal access token (scope: `repo`)
- Claude Code authenticated (the Agent SDK handles the rest)
- Git
- **Linux / WSL2 only**: `bubblewrap` and `socat` for sandbox isolation (`sudo apt-get install bubblewrap socat`)

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/stuartparmenter/claude-autopilot.git
cd claude-autopilot
bun install

# 2. Onboard your project
bun run setup /path/to/your/project

# 3. Fill in the generated files
#    - /path/to/your/project/CLAUDE.md        (project context for Claude)
#    - /path/to/your/project/.claude-autopilot.yml  (config)

# 4. Set your API keys
export LINEAR_API_KEY=lin_api_...
export GITHUB_TOKEN=ghp_...

# 5. Start the loop
bun run start /path/to/your/project
# Dashboard at http://localhost:7890
```

## Project Structure

```
claude-autopilot/
├── README.md
├── LICENSE                                # MIT
├── package.json                           # Bun project, dependencies
├── .claude/
│   ├── settings.json                      # Agent Teams flag
│   └── CLAUDE.md                          # Context for this repo
├── prompts/
│   ├── executor.md                        # Prompt for issue execution agents
│   ├── fixer.md                           # Prompt for PR fixer agents
│   ├── cto.md                             # CTO planning agent prompt
│   ├── briefing-agent.md                  # Briefing agent prompt
│   ├── scout.md                           # Scout specialist prompt
│   ├── security-analyst.md                # Security analyst prompt
│   ├── quality-engineer.md                # Quality engineer prompt
│   ├── architect.md                       # Architect prompt
│   └── issue-planner.md                   # Issue planner subagent prompt
├── plugins/
│   └── planning-skills/                   # Domain knowledge skills for planning
├── src/
│   ├── lib/
│   │   ├── config.ts                      # YAML config loading with types
│   │   ├── linear.ts                      # Linear SDK wrapper
│   │   ├── github.ts                      # GitHub/Octokit wrapper (PR status)
│   │   ├── claude.ts                      # Agent SDK wrapper with activity streaming
│   │   ├── prompt.ts                      # Template loading and rendering
│   │   └── logger.ts                      # Colored console output
│   ├── main.ts                            # Entry point — loop + dashboard
│   ├── executor.ts                        # Executor module (parallel slots)
│   ├── monitor.ts                         # Monitor module (PR status + fixers)
│   ├── planner.ts                         # Planning module (threshold + scan)
│   ├── server.ts                          # Hono dashboard (htmx partials)
│   ├── state.ts                           # In-memory app state
│   └── setup-project.ts                   # Onboard a new project
├── templates/
│   ├── CLAUDE.md.template                 # Project context template
│   ├── claude-autopilot.yml.template      # Per-project config template
│   └── linear-labels.json                 # Standard label definitions
└── docs/
    ├── architecture.md                    # System design
    ├── adding-a-project.md                # Onboarding guide
    └── tuning.md                          # Parallelism, costs, debugging
```

## Usage

```bash
# Start the loop (executor + planning + dashboard)
bun run start /path/to/project

# Custom dashboard port
bun run start /path/to/project --port 3000

# Expose dashboard to the network (WARNING: no authentication)
bun run start /path/to/project --host 0.0.0.0

# Onboard a new project
bun run setup /path/to/project
```

The single `bun run start` command:
1. Connects to Linear and resolves team/state IDs
2. Starts a Hono web dashboard on port 7890, bound to `127.0.0.1` by default (configurable with `--port` and `--host`)
3. Enters the main loop:
   - Fills executor slots (up to `executor.parallel` agents)
   - Checks if the planning loop should run (backlog threshold)
   - Waits for any agent to finish or 5-minute poll interval

## Configuration

The `.claude-autopilot.yml` file in your project controls everything. Key settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `linear.team` | Linear team key (e.g., "ENG") | *required* |
| `linear.states.ready` | State name for ready issues | `"Todo"` |
| `github.repo` | GitHub repo override ("owner/repo") | auto-detect |
| `project.name` | Project name | *required* |
| `project.test_command` | Command to run tests | `""` |
| `project.lint_command` | Command to run linter | `""` |
| `executor.parallel` | Max concurrent agents | `3` |
| `executor.timeout_minutes` | Max time per issue | `30` |
| `executor.model` | Model for executor agents | `"sonnet"` |
| `planning.model` | Model for planning agents | `"opus"` |
| `projects.model` | Model for project owner agents | `"opus"` |
| `planning.max_issues_per_run` | Max issues the planning loop files | `5` |
| `planning.min_ready_threshold` | Plan when fewer Ready issues than this | `5` |
| `planning.timeout_minutes` | Max time for planning run | `90` |
| `sandbox.enabled` | OS-level sandbox for agent bash commands | `true` |
| `sandbox.network_restricted` | Restrict network to GitHub + Linear only | `false` |
| `sandbox.extra_allowed_domains` | Additional domains when network is restricted | `[]` |

See [templates/claude-autopilot.yml.template](templates/claude-autopilot.yml.template) for the full config reference.

## How It Works

1. **Linear is the source of truth.** Issue states drive the entire system. The executor reads from Ready, writes to In Review/Blocked. The monitor watches In Review. The planning loop writes to Triage.
2. **Prompts are the product.** The TypeScript scripts are just plumbing. The prompts in `prompts/` define what Claude actually does — they're the highest-leverage thing to customize.
3. **Humans stay in the loop.** The planning loop files to Triage. A human reviews and promotes to Ready. The executor's PRs get human review before merge. Fixer agents only make minimal, non-destructive changes.
4. **Git worktrees provide isolation.** Each executor and fixer instance works in its own worktree, so parallel execution doesn't cause conflicts.
5. **Agent SDK for execution.** Claude Code agents are spawned via the `@anthropic-ai/claude-agent-sdk` with activity streaming for live dashboard updates.
6. **PR monitoring is automatic.** The monitor checks GitHub PRs linked to In Review issues. CI failures and merge conflicts are fixed automatically; unfixable issues move to Blocked.

See [docs/architecture.md](docs/architecture.md) for the full system design.

## Cost

- **Claude Max subscription**: 3-5 parallel sessions are safe. Best for getting started.
- **Claude API**: Higher parallelism possible, pay per token. ~$0.50-$2.00 per small issue, ~$2-8 per medium issue. Planning runs cost ~$5-15.
- See [docs/tuning.md](docs/tuning.md) for detailed cost guidance.

## License

MIT
