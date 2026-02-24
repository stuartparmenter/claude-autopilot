# Architecture

claude-autopilot is a self-sustaining AI development loop that turns Linear issues into shipped pull requests, and turns codebases into well-planned Linear issues. It runs as a single process: **Linear** is the source of truth for work, the **Agent SDK** spawns Claude Code agents, and a **Hono dashboard** provides live monitoring.

This document covers the system design, data flow, agent architecture, and scaling path.

---

## Design Philosophy

The architecture is built on four principles:

1. **Linear is the source of truth.** All work is represented as Linear issues with well-defined states. Humans interact with the system by triaging issues and reviewing PRs. The system never acts on work that is not tracked in Linear.

2. **Single process orchestration.** One `bun run start` command runs the executor loop, auditor timer, and web dashboard. No external orchestrator needed. The main loop fills parallel agent slots, checks the auditor threshold, and waits for agents to finish.

3. **Claude Code is the creative executor.** All code generation, codebase analysis, and implementation decisions are made by Claude Code agents running in isolated git worktrees via the Agent SDK. Claude reads prompts, reads code, and writes code. It does not make scheduling or orchestration decisions.

4. **Prompts are the product.** The quality of the system is determined by the prompts in `prompts/`. The executor prompt (`prompts/executor.md`) defines how issues become PRs. The auditor prompt (`prompts/auditor.md`) defines how codebases become issues. Tuning the system means tuning these prompts.

---

## System Overview

The system has two loops that run independently within a single process:

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
   | Claude Agent   |               | Claude Agent  |
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

   ┌─────────────────────────┐
   │   Web Dashboard (:7890) │
   │   Live agent activity   │
   │   Execution history     │
   │   Queue status          │
   └─────────────────────────┘
```

---

## The Executor Loop

The executor loop picks up ready issues from Linear and turns them into pull requests.

### Flow

```
 Linear                  Main Loop                Agent SDK              Git/GitHub
 ------                  ---------                ---------              ----------

 [Ready] issues
    |
    +---> fillSlots() ----------+
          (sorted by priority,   |
           filtered unblocked)   |
                                 v
                          start agents
                          (up to parallel limit)
                                 |
                                 +---> Agent SDK query() in worktree
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
                          (loop: fill next available slot)
```

### Key design decisions

**Worktree isolation.** Each executor agent runs in its own git worktree (`autopilot/ISSUE-ID`). This means multiple agents can run in parallel without stepping on each other's working directories. The main branch stays clean.

**Parallel agent slots.** The main loop fills up to `executor.parallel` agent slots. When an agent finishes, the slot is freed and the loop fills it with the next ready issue. `Promise.race` is used to react immediately when any agent completes.

**Activity streaming.** The Agent SDK streams messages (tool use, text, results) as they happen. These are captured as `ActivityEntry` objects and fed to the `AppState`, which the dashboard reads for live updates.

**Timeout with abort.** Each agent has a configurable timeout (default 30 minutes). When the timeout fires, the AbortController signals the agent to stop. Timed-out issues move to Blocked with a comment.

**Priority-sorted, unblocked-only.** The executor queries Linear for issues in the Ready state, sorted by priority, and filters out any issues that are blocked by incomplete issues. Dependency ordering is automatic.

**Prompt-driven Linear updates.** The executor prompt instructs Claude to update the Linear issue directly via MCP (move to Done on success, Blocked on failure). The main loop handles the timeout case.

### Source files

| File | Purpose |
|------|---------|
| `src/executor.ts` | Module. `executeIssue()` runs one issue, `fillSlots()` starts agents up to parallel limit |
| `src/lib/linear.ts` | Linear API wrapper. `getReadyIssues()`, `updateIssue()`, `resolveLinearIds()` |
| `src/lib/claude.ts` | Agent SDK wrapper. `runClaude()` with worktree, timeout, model, and activity streaming |
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
 Linear                  Main Loop                Agent SDK              Subagents
 ------                  ---------                ---------              ---------

 count(Ready) < threshold?
    |
    no --> skip (backlog sufficient)
    |
    yes --> build auditor prompt
            (includes subagent prompts)
                   |
                   +---> Agent SDK query()
                                  |
                                  +---> Phase 1: Discover
                                  |     Scan codebase across 7 dimensions
                                  |
                                  +---> Phase 2: Deep Planning
                                  |     For each top finding:
                                  |       +---> Spawn Agent Team
                                  |             +---> Planner subagent
                                  |             +---> Verifier subagent
                                  |             +---> Security Reviewer subagent
                                  |             +---> Synthesize results
                                  |
                                  +---> Phase 3: Synthesize and File
                                  |     File issues to Linear [Triage] state
                                  |
                                  +---> Phase 4: Self-Review
                                              |
                                              v
                                  Issues appear in Linear [Triage]
                                              |
                                              v
                                  Human reviews and promotes to [Ready]
```

### Backlog threshold

The auditor checks how many issues are currently in the Ready state. If the count meets or exceeds `auditor.min_ready_threshold` (default: 5), the auditor skips. This prevents flooding Linear with issues when there is already enough work queued.

### Agent Teams

The auditor uses Claude Code's Agent Teams feature to run three subagents in parallel for each finding:

**Planner** (`prompts/planner.md`): Takes a raw finding and produces a concrete, step-by-step implementation plan with exact file paths, function names, and machine-verifiable acceptance criteria.

**Verifier** (`prompts/verifier.md`): Adversarially reviews the Planner's output. Returns APPROVE, REVISE, or REJECT.

**Security Reviewer** (`prompts/security-reviewer.md`): Assesses security implications. Returns a risk level and any additional security-specific acceptance criteria.

### Source files

| File | Purpose |
|------|---------|
| `src/auditor.ts` | Module. `shouldRunAudit()` checks threshold, `runAudit()` runs the auditor agent |
| `src/lib/prompt.ts` | `buildAuditorPrompt()` assembles auditor + all subagent prompts |
| `prompts/auditor.md` | Lead auditor agent prompt (4 phases) |
| `prompts/planner.md` | Planner subagent prompt |
| `prompts/verifier.md` | Verifier subagent prompt |
| `prompts/security-reviewer.md` | Security Reviewer subagent prompt |

---

## Web Dashboard

The dashboard is a Hono web server with htmx-powered live updates. It runs in the same process as the main loop.

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | HTML shell with inline CSS (dark theme, monospace), htmx from CDN |
| `GET /api/status` | JSON state dump (agents, history, queue, auditor) |
| `GET /partials/agents` | Agent cards — htmx polls every 3s |
| `GET /partials/activity/:id` | Activity feed for an agent, `?verbose=true` for full text |
| `GET /partials/history` | Completed agents list |
| `GET /partials/stats` | Queue stats (running, ready, done, failed) |
| `GET /partials/header-meta` | Uptime display |

### Layout

```
┌─────────────────────────────────────────────────┐
│ claude-autopilot          Uptime: 2h 15m    [3] │
├──────────┬──────────────────────────────────────┤
│ AGENTS   │                                      │
│ ┌──────┐ │  ENG-42 — Add validation             │
│ │ENG-42│ │  ─────────────────────────            │
│ │ENG-43│ │  12:34:56 [tool_use] Read src/api.ts  │
│ │ENG-44│ │  12:34:58 [tool_use] Edit src/api.ts  │
│ └──────┘ │  12:35:01 [tool_use] Bash: npm test   │
│          │  12:35:15 [text] Tests passing...      │
│ HISTORY  │  12:35:20 [result] Agent completed     │
│ ┌──────┐ │                                      │
│ │ENG-40│ │                                      │
│ │ENG-39│ │                                      │
│ └──────┘ │                                      │
└──────────┴──────────────────────────────────────┘
```

### Source files

| File | Purpose |
|------|---------|
| `src/server.ts` | Hono app with HTML shell and htmx partial endpoints |
| `src/state.ts` | `AppState` class — in-memory state for agents, history, queue, auditor |

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

---

## Security Model

claude-autopilot runs agents with `bypassPermissions` mode and `allowDangerouslySkipPermissions: true`. This means agents can read/write any file and execute any shell command within the working directory without prompts.

**Why**: Autonomous operation requires headless execution. Permission prompts would block the loop.

**Mitigations**:
- **Worktree isolation**: Each agent works in its own git worktree, not on the main branch
- **Human review**: PRs require human review before merge. The auditor files to Triage (not Ready), requiring human promotion
- **Protected paths**: The `project.protected_paths` config prevents agents from modifying sensitive files (via prompt instructions, not SDK enforcement)
- **Timeout**: Agents are killed after `executor.timeout_minutes` to prevent runaway execution
- **Container recommended**: For production use, run in a Docker container or VM to sandbox filesystem and network access

The Agent SDK loads project settings (`settingSources: ['project']`) so the target project's `.claude/settings.json` and `CLAUDE.md` are respected. The `systemPrompt` uses the `claude_code` preset to get the full Claude Code system prompt including CLAUDE.md support.

---

## Data Flow

```
Human creates issues in Linear
          |
          v
bun run start <project-path>
          |
          v
Main loop queries Linear --> fills agent slots (up to parallel limit)
          |
          v
Each agent: Agent SDK query() in worktree
          |
          v
Agent implements --> pushes branch autopilot/ISSUE-ID --> opens PR
          |
          v
Agent updates Linear issue (Done or Blocked)
          |
          v
Dashboard shows live activity at http://localhost:7890
          |
          v
Human reviews PR in GitHub, reviews issue updates in Linear
```

---

## Configuration

All configuration lives in `.claude-autopilot.yml` at the root of the target project. The config is loaded by `src/lib/config.ts` and deep-merged with defaults.

### Config sections

| Section | Purpose |
|---------|---------|
| `linear` | Team key, project name, state name mappings |
| `executor` | Parallelism, timeout, auto-approve labels, branch/commit patterns, model selection |
| `auditor` | Schedule mode, backlog threshold, max issues per run, scan dimensions |
| `project` | Project name, tech stack, test/lint/build commands, key directories, protected paths |
| `notifications` | Slack webhook URL, which events trigger notifications |

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
Rendered prompt string --> passed to Agent SDK query()
```

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
Single assembled prompt --> passed to Agent SDK query()
```

---

## Repository Structure

```
claude-autopilot/
├── src/
│   ├── main.ts              # Entry point — main loop + dashboard server
│   ├── executor.ts          # Executor module (executeIssue, fillSlots)
│   ├── auditor.ts           # Auditor module (shouldRunAudit, runAudit)
│   ├── server.ts            # Hono dashboard (HTML + htmx partials)
│   ├── state.ts             # AppState class (agents, history, queue)
│   ├── setup-project.ts     # Project onboarding script
│   └── lib/
│       ├── config.ts        # YAML config loader with defaults and deep merge
│       ├── linear.ts        # Linear SDK wrapper (issues, states, labels, teams)
│       ├── claude.ts        # Agent SDK wrapper (worktree, timeout, activity streaming)
│       ├── prompt.ts        # Prompt template loader and renderer
│       └── logger.ts        # Colored console logger
├── prompts/
│   ├── executor.md          # Executor agent prompt (6 phases)
│   ├── auditor.md           # Lead auditor agent prompt (4 phases)
│   ├── planner.md           # Planner subagent prompt
│   ├── verifier.md          # Verifier subagent prompt
│   └── security-reviewer.md # Security Reviewer subagent prompt
├── templates/
│   └── CLAUDE.md.template   # Template for target project's CLAUDE.md
├── docs/                    # Documentation
├── package.json             # Bun project config, npm scripts
└── tsconfig.json            # TypeScript configuration
```
