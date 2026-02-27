# autopilot

A fully autonomous AI development loop using **Claude Code** + **Linear**.

Plans new features, implements them, opens PRs, and fixes CI failures — no human in the loop. A planning team with a Product Manager thinks about what the product should do next, not just what's broken. Four automated loops keep your project moving forward:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Linear (Ready) ──→ Claude Code ──→ Tests ──→ PR ──→ Linear    │
│       ↑              (worktree)      pass?     ✓    (In Review) │
│       │                               │                         │
│       │                               ✗                         │
│       │                               ↓                         │
│       │                          Linear (Blocked)               │
│       │                                                         │
│       │                        EXECUTOR LOOP                    │
│       │                                                         │
│  ─────┼─────────────────────────────────────────────────────    │
│       │                                                         │
│  Project Owner ──→ accepts & decomposes ──→ Ready               │
│       ↑                                                         │
│       │                                                         │
│  Linear (Triage) ←── Claude Code ←── Codebase scan             │
│                       (CTO Agent Team)                          │
│                       ├─ Product Manager                        │
│                       ├─ Scout                                  │
│                       ├─ Security Analyst                       │
│                       ├─ Quality Engineer                       │
│                       └─ Architect                              │
│                                                                 │
│                  PLANNING + PROJECTS LOOPS                      │
│                                                                 │
│  ───────────────────────────────────────────────────────────    │
│                                                                 │
│  Linear (In Review) ──→ Check PR ──→ CI failed? ──→ Fixer      │
│                                      Conflict?       (worktree) │
│                                         │               │       │
│                                         ✗               ↓       │
│                                        skip       Push fix to   │
│                                                   existing PR   │
│                          ↓                                      │
│                     CI passes ──→ Auto-merge ──→ Done           │
│                                                                 │
│                        MONITOR LOOP                             │
└─────────────────────────────────────────────────────────────────┘
```

**Executor**: Pulls unblocked "Ready" issues from Linear, spawns Claude Code agents in isolated git worktrees, implements the change, runs tests, pushes a PR (with auto-merge enabled), and updates Linear. Runs multiple agents in parallel.

**Monitor**: Watches issues in "In Review" state. Checks their linked GitHub PRs for CI failures, merge conflicts, and review feedback. Spawns fixer agents to repair CI/conflicts automatically, and review-responder agents to address requested changes. If a fix can't be applied after max attempts, moves the issue to "Blocked".

**Planning**: When the backlog runs low, a CTO agent leads a team of specialists — Scout, Security Analyst, Quality Engineer, Architect, and a **Product Manager** — to investigate the codebase. The PM maintains a living Product Brief, tracks strategic continuity across sessions, and identifies opportunities for new features and capabilities alongside technical improvements. Findings are filed as well-planned issues to "Triage" via Issue Planner subagents.

**Projects**: Polls active projects for triage issues. Spawns project-owner agents that accept or defer issues, spawn technical planners to decompose accepted issues into Ready sub-issues, and track project health.

**Dashboard**: A web UI shows live agent activity, execution history, and queue status.

## Security Notice

autopilot runs Claude Code agents with **`bypassPermissions`** mode, which gives agents unrestricted access to read/write files and execute shell commands. To mitigate this, **OS-level sandboxing is enabled by default** — each agent's bash commands are isolated to its worktree directory, and sandbox escape is hardcoded off (`allowUnsandboxedCommands: false`).

**Sandbox prerequisites:**
- **Linux / WSL2**: `sudo apt-get install bubblewrap socat`
- **macOS**: The Agent SDK uses its own sandbox mechanism (no extra packages needed)

If bubblewrap/socat are not installed on Linux, the SDK may silently fall back to no sandboxing. You can disable the sandbox in `.autopilot.yml` (`sandbox.enabled: false`), but this means agents have unrestricted filesystem access — only do this if you're running in an already-isolated environment.

**Additional recommendations:**
- Run in a **container or VM** for defense in depth, even with sandboxing enabled
- Use **git worktrees** (the default) so agents work on branches, not main
- Review PRs before merging, or use `github.automerge: true` with branch protection rules so CI gates the merge
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
git clone https://github.com/stuartparmenter/autopilot.git
cd autopilot
bun install

# 2. Onboard your project
bun run setup /path/to/your/project

# 3. Fill in the generated files
#    - /path/to/your/project/CLAUDE.md        (project context for Claude)
#    - /path/to/your/project/.autopilot.yml  (config)

# 4. Set your API keys
export LINEAR_API_KEY=lin_api_...
export GITHUB_TOKEN=ghp_...

# 5. Start the loop
bun run start /path/to/your/project
# Dashboard at http://localhost:7890
```

## Project Structure

```
autopilot/
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
│   ├── autopilot.yml.template      # Per-project config template
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

The `.autopilot.yml` file in your project controls everything. Key settings:

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
| `projects.enabled` | Enable the projects loop | `true` |
| `projects.max_active_projects` | Cap on concurrent project owner agents | `5` |
| `github.automerge` | Enable auto-merge on PRs (requires branch protection) | `false` |
| `monitor.respond_to_reviews` | Spawn agents to address PR review feedback | `false` |
| `sandbox.enabled` | OS-level sandbox for agent bash commands | `true` |
| `sandbox.network_restricted` | Restrict network to GitHub + Linear only | `false` |
| `sandbox.extra_allowed_domains` | Additional domains when network is restricted | `[]` |

See [templates/autopilot.yml.template](templates/autopilot.yml.template) for the full config reference.

## How It Works

1. **Linear is the source of truth.** Issue states drive the entire system. The executor reads from Ready, writes to In Review/Blocked. The monitor watches In Review. The planning loop writes to Triage. Project owners triage into Ready.
2. **Prompts are the product.** The TypeScript scripts are just plumbing. The prompts in `prompts/` and agent definitions in `plugins/` define what Claude actually does — they're the highest-leverage thing to customize.
3. **Fully autonomous by default.** The planning loop files to Triage — not just tech debt and bug fixes, but new features, capability extensions, and product improvements identified by the PM agent. Project owners triage and decompose into Ready sub-issues. The executor implements and opens PRs with auto-merge. The monitor fixes CI failures, resolves merge conflicts, and responds to review feedback. No human intervention required — but you can still review PRs and triage issues if you want oversight.
4. **Git worktrees provide isolation.** Each executor and fixer instance works in its own worktree, so parallel execution doesn't cause conflicts.
5. **Agent SDK for execution.** Claude Code agents are spawned via the `@anthropic-ai/claude-agent-sdk` with activity streaming for live dashboard updates.
6. **PR monitoring is automatic.** The monitor checks GitHub PRs linked to In Review issues. CI failures, merge conflicts, and review feedback are handled automatically; unfixable issues move to Blocked.

See [docs/architecture.md](docs/architecture.md) for the full system design.

## Cost

- **Claude Max subscription**: 3-5 parallel sessions are safe. Best for getting started.
- **Claude API**: Higher parallelism possible, pay per token. ~$0.50-$2.00 per small issue, ~$2-8 per medium issue. Planning runs cost ~$5-15.
- See [docs/tuning.md](docs/tuning.md) for detailed cost guidance.

## License

MIT
