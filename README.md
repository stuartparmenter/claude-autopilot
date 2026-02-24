# claude-autopilot

A self-sustaining AI development loop using **Claude Code** + **Linear** + **n8n**.

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

**Executor**: Pulls unblocked "Ready" issues from Linear, spawns Claude Code in isolated git worktrees, implements the change, runs tests, pushes a PR, and updates Linear.

**Auditor**: When the backlog runs low, scans the codebase for improvements. Uses an Agent Team (Planner + Verifier + Security Reviewer) to produce well-planned issues filed to "Triage" for human review.

**You**: Review Triage, promote good issues to Ready, and the loop continues.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Bun](https://bun.sh) runtime
- [Linear](https://linear.app) account with API key
- [n8n](https://n8n.io) (optional — only needed for Phase 2 automation)
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

# 6. Validate everything works
bun run test-loop /path/to/your/project

# 7. Run the executor
bun run executor /path/to/your/project once   # One issue
bun run executor /path/to/your/project loop   # Continuous
```

## Project Structure

```
claude-autopilot/
├── README.md
├── LICENSE                                # MIT
├── package.json                           # Bun project, @linear/sdk
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
│   │   ├── claude.ts                      # Claude CLI execution
│   │   ├── prompt.ts                      # Template loading and rendering
│   │   └── logger.ts                      # Colored console output
│   ├── setup-project.ts                   # Onboard a new project
│   ├── executor.ts                        # Execute Linear issues
│   ├── auditor.ts                         # Audit codebase, file issues
│   └── test-loop.ts                       # Validate setup end-to-end
├── n8n/
│   ├── executor-workflow.json             # Phase 2 n8n workflow
│   ├── auditor-workflow.json              # Phase 2 n8n workflow
│   └── setup.md                           # n8n configuration guide
├── templates/
│   ├── CLAUDE.md.template                 # Project context template
│   ├── claude-autopilot.yml.template      # Per-project config template
│   └── linear-labels.json                 # Standard label definitions
└── docs/
    ├── architecture.md                    # System design
    ├── adding-a-project.md                # Onboarding guide
    └── tuning.md                          # Parallelism, costs, debugging
```

## Phases

### Phase 1: Scripts (start here)

Run everything locally with Bun scripts. One issue at a time. No n8n required.

```bash
bun run executor /path/to/project once
bun run auditor /path/to/project
```

### Phase 2: n8n Automation

Import the n8n workflows for scheduling, parallelism (3-5 concurrent executors), and monitoring. See [n8n/setup.md](n8n/setup.md).

### Phase 3: Self-Improving

- Auto-approve low-risk labels (test-coverage, documentation)
- Cost tracking and budget limits
- Multi-project orchestration
- Auditor learns from executor success/failure patterns

## Configuration

The `.claude-autopilot.yml` file in your project controls everything. Key settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `linear.team` | Linear team key (e.g., "ENG") | *required* |
| `linear.states.ready` | State name for ready issues | `"Todo"` |
| `project.name` | Project name | *required* |
| `project.test_command` | Command to run tests | `""` |
| `project.lint_command` | Command to run linter | `""` |
| `executor.timeout_minutes` | Max time per issue | `30` |
| `auditor.max_issues_per_run` | Max issues the auditor files | `10` |
| `auditor.min_ready_threshold` | Audit when fewer Ready issues than this | `5` |

See [templates/claude-autopilot.yml.template](templates/claude-autopilot.yml.template) for the full config reference.

## How It Works

1. **Linear is the source of truth.** Issue states drive the entire system. The executor reads from Ready, writes to Done/Blocked. The auditor writes to Triage.
2. **Prompts are the product.** The TypeScript scripts are just plumbing. The prompts in `prompts/` define what Claude actually does — they're the highest-leverage thing to customize.
3. **Humans stay in the loop.** The auditor files to Triage. A human reviews and promotes to Ready. The executor's PRs get human review before merge.
4. **Git worktrees provide isolation.** Each executor instance works in its own worktree, so parallel execution doesn't cause conflicts.

See [docs/architecture.md](docs/architecture.md) for the full system design.

## Cost

- **Claude Max subscription**: 3-5 parallel sessions are safe. Best for getting started.
- **Claude API**: Higher parallelism possible, pay per token. ~$0.50-$2.00 per small issue, ~$2-8 per medium issue. Auditor runs cost ~$5-15.
- See [docs/tuning.md](docs/tuning.md) for detailed cost guidance.

## License

MIT
