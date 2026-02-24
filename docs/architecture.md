# Architecture

claude-autopilot is a self-sustaining AI development loop that turns Linear issues into shipped pull requests, and turns codebases into well-planned Linear issues. It connects three systems: **Linear** (source of truth for work), **n8n** (deterministic orchestrator), and **Claude Code** (creative executor).

This document covers the system design, data flow, agent architecture, and scaling path.

---

## Design Philosophy

The architecture is built on four principles:

1. **Linear is the source of truth.** All work is represented as Linear issues with well-defined states. Humans interact with the system by triaging issues and reviewing PRs. The system never acts on work that is not tracked in Linear.

2. **n8n is the deterministic orchestrator.** Scheduling, polling, parallelism, and retry logic live in n8n workflows, not in application code. n8n is stateless glue that calls Bun scripts. If n8n goes down, nothing breaks -- the scripts are independently runnable.

3. **Claude Code is the creative executor.** All code generation, codebase analysis, and implementation decisions are made by Claude Code instances running in isolated git worktrees. Claude reads prompts, reads code, and writes code. It does not make scheduling or orchestration decisions.

4. **Prompts are the product.** The quality of the system is determined by the prompts in `prompts/`. The executor prompt (`prompts/executor.md`) defines how issues become PRs. The auditor prompt (`prompts/auditor.md`) defines how codebases become issues. Tuning the system means tuning these prompts.

---

## System Overview

The system has two loops that run independently:

```
                    +-----------+
                    |   Human   |
                    +-----+-----+
                          |
                   reviews Triage,
                   promotes to Ready,
                   reviews PRs
                          |
          +---------------+----------------+
          |                                |
          v                                v
   +------+-------+               +-------+------+
   | Executor Loop |               | Auditor Loop |
   +------+-------+               +-------+------+
          |                                |
    pulls Ready issues             scans codebase
    from Linear                    files Triage issues
          |                        to Linear
          v                                |
   +------+-------+               +-------+------+
   | Claude Code   |               | Claude Code   |
   | (in worktree) |               | + Agent Team  |
   +------+-------+               +-------+------+
          |                                |
    implements issue               Planner + Verifier
    runs tests/lint                + Security Reviewer
    pushes branch                  subagents review
    opens PR                       each finding
    updates Linear                        |
          |                                v
          v                        files issues to
   +------+-------+               Linear Triage state
   |   GitHub PR   |
   +--------------+
```

---

## The Executor Loop

The executor loop picks up ready issues from Linear and turns them into pull requests.

### Flow

```
 Linear                  Bun Script               Claude Code              Git/GitHub
 ------                  ----------               -----------              ----------

 [Ready] issues
    |
    +---> getReadyIssues() ------+
          (sorted by priority,   |
           filtered unblocked)   |
                                 v
                          pick top issue
                                 |
                          updateIssue() --> [In Progress]
                                 |
                                 +---> claude --worktree autopilot/ISSUE-ID -p <prompt>
                                                    |
                                                    +---> Phase 1: Read issue via Linear MCP
                                                    |     Phase 2: Plan approach
                                                    |     Phase 3: Implement changes
                                                    |     Phase 4: Run tests + lint
                                                    |     Phase 5: Commit, push, open PR -----> PR created
                                                    |     Phase 6: Update Linear
                                                    |
                                                    +---> success: issue --> [Done]
                                                    |     failure: issue --> [Blocked]
                                                    |     timeout: issue --> [Blocked]
                                                    v
                          (loop mode: pick next issue)
```

### Key design decisions

**Worktree isolation.** Each executor instance runs in its own git worktree (`autopilot/ISSUE-ID`). This means multiple executors can run in parallel without stepping on each other's working directories. The main branch stays clean.

**Timeout with graceful shutdown.** Each executor has a configurable timeout (default 30 minutes). When the timeout fires, the process gets SIGTERM first (10 second grace period), then SIGKILL. Timed-out issues move to Blocked with a comment explaining the timeout.

**Priority-sorted, unblocked-only.** The executor queries Linear for issues in the Ready state, sorted by priority, and filters out any issues that are blocked by incomplete issues. This means dependency ordering is automatic -- if issue B depends on issue A, issue B won't be picked up until A is done.

**Prompt-driven Linear updates.** The executor prompt instructs Claude to update the Linear issue directly via MCP (move to Done on success, Blocked on failure). The Bun script handles the timeout case. This keeps the happy path inside Claude's context, where it has full information about what happened.

### Source files

| File | Purpose |
|------|---------|
| `src/executor.ts` | Entry point. Parses args, loads config, runs once or in loop mode |
| `src/lib/linear.ts` | Linear API wrapper. `getReadyIssues()`, `updateIssue()`, `resolveLinearIds()` |
| `src/lib/claude.ts` | Claude Code CLI wrapper. `runClaude()` with worktree and timeout support |
| `src/lib/prompt.ts` | Prompt template loader. `buildPrompt()` loads and renders `prompts/executor.md` |
| `prompts/executor.md` | The executor agent prompt (6 phases: understand, plan, implement, validate, commit, update) |

### Linear state transitions (executor)

```
Ready --> In Progress --> Done      (success)
                      --> Blocked   (failure, timeout, or ambiguous requirements)
```

---

## The Auditor Loop

The auditor loop scans the codebase for improvements and files well-planned Linear issues.

### Flow

```
 Linear                  Bun Script               Claude Code              Subagents
 ------                  ----------               -----------              ---------

 count(Ready) < threshold?
    |
    no --> exit (backlog sufficient)
    |
    yes --> build auditor prompt
            (includes subagent prompts)
                   |
                   +---> claude -p <auditor prompt>
                                  |
                                  +---> Phase 1: Discover
                                  |     Scan codebase across 7 dimensions:
                                  |       test-coverage, error-handling,
                                  |       performance, security, code-quality,
                                  |       dependency-health, documentation
                                  |
                                  +---> Phase 2: Deep Planning
                                  |     For each top finding:
                                  |       |
                                  |       +---> Spawn Agent Team
                                  |             |
                                  |             +---> Planner subagent
                                  |             |     (implementation plan)
                                  |             |
                                  |             +---> Verifier subagent
                                  |             |     (adversarial review)
                                  |             |
                                  |             +---> Security Reviewer subagent
                                  |                   (security assessment)
                                  |             |
                                  |             +---> Synthesize results
                                  |                   REJECT --> drop finding
                                  |                   REVISE --> incorporate feedback
                                  |                   APPROVE --> proceed
                                  |
                                  +---> Phase 3: Synthesize and File
                                  |     File issues to Linear [Triage] state
                                  |     with labels, priority, acceptance criteria,
                                  |     sub-issues, and dependency relations
                                  |
                                  +---> Phase 4: Self-Review
                                        Deduplicate, check dependency coherence,
                                        enforce cap, spot-check quality
                                              |
                                              v
                                  Issues appear in Linear [Triage]
                                              |
                                              v
                                  Human reviews and promotes to [Ready]
```

### Backlog threshold

The auditor checks how many issues are currently in the Ready state. If the count meets or exceeds `auditor.min_ready_threshold` (default: 5), the auditor exits immediately. This prevents the auditor from flooding Linear with issues when there is already enough work queued.

### Agent Teams

The auditor uses Claude Code's Agent Teams feature to run three subagents in parallel for each finding:

**Planner** (`prompts/planner.md`): Takes a raw finding and produces a concrete, step-by-step implementation plan. The plan includes exact file paths, function names, line numbers, and machine-verifiable acceptance criteria for each step. The Planner reads the actual codebase to match existing patterns.

**Verifier** (`prompts/verifier.md`): Adversarially reviews the Planner's output. Checks feasibility (do the referenced files and functions exist?), completeness (are edge cases handled?), acceptance criteria quality (are they truly machine-verifiable?), risk (could this break existing functionality?), and dependency correctness. Returns APPROVE, REVISE, or REJECT.

**Security Reviewer** (`prompts/security-reviewer.md`): Assesses security implications of the proposed change. Checks for new attack surface, sensitive data handling, security best practices, and whether the change weakens existing controls. Returns a risk level (NONE through CRITICAL) and any additional security-specific acceptance criteria.

All three run in parallel. The lead auditor synthesizes their output:
- If the Verifier says REJECT, the finding is dropped.
- If the Verifier says REVISE, the feedback is incorporated into the final issue.
- Security findings and additional acceptance criteria are added to the issue.

### Issue quality standards

Every issue filed by the auditor must have:
- An actionable title starting with a verb
- A structured description with Context, Implementation Plan, Acceptance Criteria, Estimate, Security Notes, and Verifier Notes
- Machine-verifiable acceptance criteria (an autonomous agent must be able to determine pass/fail)
- Labels: `auto-audit` + one category label + one severity label
- Priority: P1 (urgent) through P4 (low)
- Dependency relations to existing issues where applicable
- Sub-issues for anything requiring more than 3 implementation steps

All issues are filed to the **Triage** state. A human reviews Triage and promotes issues to Ready when they are satisfied with the plan.

### Source files

| File | Purpose |
|------|---------|
| `src/auditor.ts` | Entry point. Checks backlog threshold, builds prompt, runs Claude |
| `src/lib/prompt.ts` | `buildAuditorPrompt()` assembles auditor + all subagent prompts |
| `prompts/auditor.md` | Lead auditor agent prompt (4 phases: discover, deep planning, synthesize, self-review) |
| `prompts/planner.md` | Planner subagent prompt |
| `prompts/verifier.md` | Verifier subagent prompt |
| `prompts/security-reviewer.md` | Security Reviewer subagent prompt |

### Linear state transitions (auditor)

```
(nothing) --> Triage    (auditor files new issues)
Triage    --> Ready     (human promotes after review)
```

---

## Linear State Machine

The full Linear state machine across both loops:

```
                     +----------+
                     |  Triage  | <--- Auditor files new issues here
                     +----+-----+
                          |
                    human promotes
                          |
                          v
                     +----+-----+
              +----> |  Ready   | <--- Executor pulls from here
              |      |  (Todo)  |
              |      +----+-----+
              |           |
              |     executor picks up
              |           |
              |           v
              |   +-------+--------+
              |   |  In Progress   |
              |   +-------+--------+
              |           |
              |     +-----+------+
              |     |            |
              |  success      failure/
              |     |         timeout
              |     v            |
              |  +--+---+   +---+------+
              |  | Done |   | Blocked  |
              |  +------+   | (Backlog)|
              |             +---+------+
              |                 |
              +---- human fixes and re-promotes
```

**State mapping in config:**

| Logical state | Default Linear state | Purpose |
|---------------|---------------------|---------|
| `triage` | Triage | Auditor output, awaiting human review |
| `ready` | Todo | Approved work, ready for executor |
| `in_progress` | In Progress | Currently being worked on by executor |
| `done` | Done | Successfully implemented and PR opened |
| `blocked` | Backlog | Executor failed, timed out, or issue was ambiguous |

These state names are configurable in `.claude-autopilot.yml` under `linear.states` to match your team's workflow.

---

## Data Flow: Linear, Git, and n8n

### Without n8n (Phase 1: Bun scripts)

```
Human creates issues in Linear
          |
          v
bun run executor <project-path> once    (or loop)
          |
          v
Executor queries Linear --> picks Ready issue --> spawns Claude in worktree
          |
          v
Claude implements --> pushes branch autopilot/ISSUE-ID --> opens PR
          |
          v
Claude updates Linear issue (Done or Blocked)
          |
          v
Human reviews PR in GitHub, reviews issue updates in Linear
```

### With n8n (Phase 2+: orchestrated)

```
+-------------------+
| n8n: Cron trigger |  (every 5 min)
+--------+----------+
         |
         v
+--------+-----------+
| n8n: Check Linear  |  (count Ready issues)
| for ready issues   |
+--------+-----------+
         |
    issues found?
    |           |
    yes         no --> trigger auditor? (if backlog < threshold)
    |                    |
    v                    v
+---+----------------+  +--+------------------+
| n8n: Spawn up to N |  | n8n: Run auditor    |
| executor instances |  | bun run auditor ... |
| (parallel)         |  +---------------------+
+---+----------------+
    |
    v
Each instance: bun run executor <project-path> once
    |
    v
Results flow back to n8n for logging/notifications
```

n8n adds:
- **Scheduled polling** instead of manual runs
- **Parallel execution** (configurable concurrency, default 3)
- **Notifications** (Slack webhook on completion, failure, or error)
- **Auditor scheduling** (when_idle mode triggers auditor when backlog is low)
- **Error handling and retry** at the orchestration layer

---

## Configuration

All configuration lives in `.claude-autopilot.yml` at the root of the target project. The config is loaded by `src/lib/config.ts` and deep-merged with defaults.

### Config sections

| Section | Purpose |
|---------|---------|
| `linear` | Team key, project name, state name mappings |
| `executor` | Parallelism, timeout, auto-approve labels, branch/commit patterns |
| `auditor` | Schedule mode, backlog threshold, max issues per run, scan dimensions |
| `project` | Project name, tech stack, test/lint/build commands, key directories, protected paths |
| `notifications` | Slack webhook URL, which events trigger notifications |

See `adding-a-project.md` for detailed configuration guidance.

---

## Prompt Architecture

Prompts are Markdown files in `prompts/` with `{{VARIABLE}}` placeholders. The `src/lib/prompt.ts` module loads and renders them at runtime.

### Executor prompt flow

```
prompts/executor.md
        |
        v
buildPrompt("executor", { ISSUE_ID, TEST_COMMAND, LINT_COMMAND, ... })
        |
        v
Rendered prompt string --> passed to claude -p
```

Template variables: `{{ISSUE_ID}}`, `{{TEST_COMMAND}}`, `{{LINT_COMMAND}}`, `{{DONE_STATE}}`, `{{BLOCKED_STATE}}`, `{{PROJECT_NAME}}`, `{{TECH_STACK}}`

### Auditor prompt flow

```
prompts/auditor.md
prompts/planner.md       \
prompts/verifier.md       |--- all appended to one prompt
prompts/security-reviewer.md /
        |
        v
buildAuditorPrompt({ LINEAR_TEAM, LINEAR_PROJECT, TRIAGE_STATE, ... })
        |
        v
Single assembled prompt --> passed to claude -p
```

The auditor prompt includes all subagent prompts as a "Reference: Subagent Prompts" section. The lead auditor agent uses these prompts when spawning Agent Team subagents.

Template variables: `{{LINEAR_TEAM}}`, `{{LINEAR_PROJECT}}`, `{{TRIAGE_STATE}}`, `{{MAX_ISSUES_PER_RUN}}`, `{{PROJECT_NAME}}`, `{{TECH_STACK}}`

---

## Scaling Path

### Phase 1: Bun Scripts (current)

- Run executor and auditor manually from the command line
- One issue at a time (`bun run executor <path> once`)
- Loop mode processes issues sequentially (`bun run executor <path> loop`)
- Good for: initial setup, testing, low-volume projects

### Phase 2: n8n Orchestration

- n8n polls Linear on a cron schedule
- Spawns 3-5 executor instances in parallel
- Triggers auditor automatically when backlog drops below threshold
- Slack notifications on completion and failure
- Good for: steady-state operation, teams with regular issue flow

### Phase 3: Full Automation

- **Auto-approval**: Issues with safe labels (`test-coverage`, `documentation`, `dependency-update`) are auto-promoted from Triage to Ready, bypassing human review for low-risk work
- **Cost tracking**: Per-issue token usage tracking, budget caps per day/week, cost alerts
- **Multi-project**: Single n8n instance manages multiple project repositories, each with its own `.claude-autopilot.yml`
- **Feedback loop**: Track executor success rate per issue category and project; feed metrics back into auditor prompt to improve issue quality
- Good for: organizations running autopilot across multiple codebases

---

## Repository Structure

```
claude-autopilot/
├── src/
│   ├── executor.ts           # Executor entry point
│   ├── auditor.ts            # Auditor entry point
│   ├── setup-project.ts      # Project onboarding script
│   ├── test-loop.ts          # Setup validation / smoke test
│   └── lib/
│       ├── config.ts         # YAML config loader with defaults and deep merge
│       ├── linear.ts         # Linear SDK wrapper (issues, states, labels, teams)
│       ├── claude.ts         # Claude Code CLI wrapper (worktree, timeout)
│       ├── prompt.ts         # Prompt template loader and renderer
│       └── logger.ts         # Colored console logger
├── prompts/
│   ├── executor.md           # Executor agent prompt (6 phases)
│   ├── auditor.md            # Lead auditor agent prompt (4 phases)
│   ├── planner.md            # Planner subagent prompt
│   ├── verifier.md           # Verifier subagent prompt
│   └── security-reviewer.md  # Security Reviewer subagent prompt
├── templates/
│   └── CLAUDE.md.template    # Template for target project's CLAUDE.md
├── n8n/                      # n8n workflow exports (Phase 2+)
├── docs/                     # Documentation
├── package.json              # Bun project config, npm scripts
└── tsconfig.json             # TypeScript configuration
```
