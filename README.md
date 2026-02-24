# claude-autopilot

A self-sustaining AI development loop using **Claude Code** + **Linear**.

Two automated loops keep your project moving forward:

```
┌─────────────────────────────────────────────────────────────────┐
│                        EXECUTOR LOOP                            │
│                                                                 │
│  Linear (Ready) ──→ Claude Code ──→ Tests ──→ PR ──→ Linear    │
│       ↑              (worktree)      pass?     ✓     (Done)     │
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
│                       ├─ Planner                                │
│                       ├─ Verifier                               │
│                       └─ Security Reviewer                      │
│                                                                 │
│                        AUDITOR LOOP                             │
└─────────────────────────────────────────────────────────────────┘
```

**Executor**: Pulls unblocked "Ready" issues from Linear, spawns Claude Code agents in isolated git worktrees, implements the change, runs tests, pushes a PR, and updates Linear. Runs multiple agents in parallel.

**Auditor**: When the backlog runs low, scans the codebase for improvements. Uses an Agent Team (Planner + Verifier + Security Reviewer) to produce well-planned issues filed to "Triage" for human review.

**Dashboard**: A web UI shows live agent activity, execution history, and queue status.

**You**: Review Triage, promote good issues to Ready, and the loop continues.

## Security Notice

claude-autopilot runs Claude Code agents with **`bypassPermissions`** mode, which gives agents unrestricted access to read/write files and execute shell commands in the target project directory. This is necessary for autonomous operation but carries risk.

**Recommendations:**
- Run in a **container or VM** to isolate the agent's filesystem and network access
- Use **git worktrees** (the default) so agents work on branches, not main
- Review all PRs before merging — the human review step is your safety net
- Set `project.protected_paths` in config to prevent modification of sensitive files
- Start with `executor.parallel: 1` and watch the dashboard closely before scaling up

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Linear](https://linear.app) account with API key
- Claude Code authenticated (the Agent SDK handles the rest)
- Git

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

# 4. Set your Linear API key
export LINEAR_API_KEY=lin_api_...

# 5. Authenticate Linear MCP (for Claude Code agents)
cd /path/to/your/project && claude
# Then type /mcp and authenticate Linear

# 6. Start the loop
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
│   ├── auditor.md                         # Lead auditor prompt
│   ├── planner.md                         # Subagent: decompose into tasks
│   ├── verifier.md                        # Subagent: challenge and validate
│   └── security-reviewer.md              # Subagent: security review
├── src/
│   ├── lib/
│   │   ├── config.ts                      # YAML config loading with types
│   │   ├── linear.ts                      # Linear SDK wrapper
│   │   ├── claude.ts                      # Agent SDK wrapper with activity streaming
│   │   ├── prompt.ts                      # Template loading and rendering
│   │   └── logger.ts                      # Colored console output
│   ├── main.ts                            # Entry point — loop + dashboard
│   ├── executor.ts                        # Executor module (parallel slots)
│   ├── auditor.ts                         # Auditor module (threshold + scan)
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
# Start the loop (executor + auditor + dashboard)
bun run start /path/to/project

# Custom dashboard port
bun run start /path/to/project --port 3000

# Onboard a new project
bun run setup /path/to/project
```

The single `bun run start` command:
1. Connects to Linear and resolves team/state IDs
2. Starts a Hono web dashboard on port 7890 (configurable with `--port`)
3. Enters the main loop:
   - Fills executor slots (up to `executor.parallel` agents)
   - Checks if the auditor should run (backlog threshold)
   - Waits for any agent to finish or 5-minute poll interval

## Configuration

The `.claude-autopilot.yml` file in your project controls everything. Key settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `linear.team` | Linear team key (e.g., "ENG") | *required* |
| `linear.states.ready` | State name for ready issues | `"Todo"` |
| `project.name` | Project name | *required* |
| `project.test_command` | Command to run tests | `""` |
| `project.lint_command` | Command to run linter | `""` |
| `executor.parallel` | Max concurrent agents | `3` |
| `executor.timeout_minutes` | Max time per issue | `30` |
| `executor.model` | Model for executor agents | `"sonnet"` |
| `executor.planning_model` | Model for auditor/planning | `"opus"` |
| `auditor.max_issues_per_run` | Max issues the auditor files | `10` |
| `auditor.min_ready_threshold` | Audit when fewer Ready issues than this | `5` |

See [templates/claude-autopilot.yml.template](templates/claude-autopilot.yml.template) for the full config reference.

## How It Works

1. **Linear is the source of truth.** Issue states drive the entire system. The executor reads from Ready, writes to Done/Blocked. The auditor writes to Triage.
2. **Prompts are the product.** The TypeScript scripts are just plumbing. The prompts in `prompts/` define what Claude actually does — they're the highest-leverage thing to customize.
3. **Humans stay in the loop.** The auditor files to Triage. A human reviews and promotes to Ready. The executor's PRs get human review before merge.
4. **Git worktrees provide isolation.** Each executor instance works in its own worktree, so parallel execution doesn't cause conflicts.
5. **Agent SDK for execution.** Claude Code agents are spawned via the `@anthropic-ai/claude-agent-sdk` with activity streaming for live dashboard updates.

See [docs/architecture.md](docs/architecture.md) for the full system design.

## Cost

- **Claude Max subscription**: 3-5 parallel sessions are safe. Best for getting started.
- **Claude API**: Higher parallelism possible, pay per token. ~$0.50-$2.00 per small issue, ~$2-8 per medium issue. Auditor runs cost ~$5-15.
- See [docs/tuning.md](docs/tuning.md) for detailed cost guidance.

## License

MIT
