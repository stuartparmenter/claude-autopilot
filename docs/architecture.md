# Architecture

claude-autopilot is a self-sustaining AI development loop that turns Linear issues into shipped pull requests, and turns codebases into well-planned Linear issues. It runs as a single process: **Linear** is the source of truth for work, the **Agent SDK** spawns Claude Code agents, and a **Hono dashboard** provides live monitoring.

This document covers the system design, data flow, agent architecture, and scaling path.

---

## Design Philosophy

The architecture is built on four principles:

1. **Linear is the source of truth.** All work is represented as Linear issues with well-defined states. Humans interact with the system by triaging issues and reviewing PRs. The system never acts on work that is not tracked in Linear.

2. **Single process orchestration.** One `bun run start` command runs the executor loop, planning timer, and web dashboard. No external orchestrator needed. The main loop fills parallel agent slots, checks the planning threshold, and waits for agents to finish.

3. **Claude Code is the creative executor.** All code generation, codebase analysis, and implementation decisions are made by Claude Code agents running in isolated git worktrees via the Agent SDK. Claude reads prompts, reads code, and writes code. It does not make scheduling or orchestration decisions.

4. **Prompts are the product.** The quality of the system is determined by the prompts in `prompts/`. The executor prompt (`prompts/executor.md`) defines how issues become PRs. The CTO prompt (`prompts/cto.md`) defines how codebases become issues. Tuning the system means tuning these prompts.

---

## System Overview

The system has four loops that run independently within a single process:

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
   | Executor Loop |               | Planning Loop|
   +------+-------+               +-------+------+
          |                                |
    pulls Ready issues             scans codebase
    from Linear (team-wide)        files Triage issues
          |                        to Linear projects
          v                                |
   +------+-------+               +-------+------+
   | Claude Agent   |               | CTO Agent     |
   | (in worktree) |               | + PM + Specs  |
   +------+-------+               +-------+------+
          |                                |
    implements issue               PM + Scout + Security
    runs tests/lint                + Quality + Architect
    pushes branch                  + Issue Planners
    opens PR                               |
    updates Linear                         v
          |                        groups into projects,
          v                        files to Triage
   +------+-------+
   |   GitHub PR   |         +--------+---------+
   +--------------+         | Projects Loop     |
                             +--------+---------+
                                      |
                               polls initiative
                               projects for triage
                                      |
                                      v
                             +--------+---------+
                             | Project Owner    |
                             | + Tech Planner   |
                             +------------------+
                                      |
                               triages issues,
                               decomposes into
                               sub-issues (Ready)

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

## The Planning Loop

The planning loop scans the codebase for improvements and files well-planned Linear issues using a team-based investigation approach.

### Flow

```
 Linear                  Main Loop                Agent SDK              Specialists
 ------                  ---------                ---------              -----------

 count(Ready) < threshold?
    |
    no --> skip (backlog sufficient)
    |
    yes --> build planning prompt
            (CTO agent with specialist team)
                   |
                   +---> Agent SDK query()
                                  |
                                  +---> CTO Agent orchestrates investigation
                                  |     Spawns specialist subagents:
                                  |       +---> Scout (codebase exploration)
                                  |       +---> Security Analyst (security review)
                                  |       +---> Quality Engineer (quality assessment)
                                  |       +---> Architect (design review)
                                  |
                                  +---> CTO synthesizes findings
                                  |     Spawns Issue Planner subagents
                                  |     to file well-planned issues
                                  |
                                  +---> Issues filed to Linear [Triage] state
                                              |
                                              v
                                  Human reviews and promotes to [Ready]
```

### Backlog threshold

The planning loop checks how many issues are currently in the Ready state. If the count meets or exceeds `planning.min_ready_threshold` (default: 5), the planning loop skips. This prevents flooding Linear with issues when there is already enough work queued.

### CTO Agent Team

The planning loop uses a CTO agent that leads a team of specialists:

**Briefing Agent**: Prepares a "State of the Project" summary — git history, Linear state, trends, and previous planning updates from status updates.

**Product Manager**: Researches product opportunities, maintains a Product Brief document on the initiative. Brainstorms feature ideas grounded in codebase evidence.

**Scout**: Explores the codebase to identify areas for improvement.

**Security Analyst**: Assesses security implications and identifies vulnerabilities.

**Quality Engineer**: Evaluates code quality, test coverage, and engineering practices.

**Architect**: Reviews system design and architectural patterns.

**Issue Planner**: Takes synthesized findings and produces concrete, well-planned Linear issues with implementation details and acceptance criteria. Files issues into the correct project (as assigned by the CTO).

The `plugins/planning-skills/` directory provides agent definitions and domain knowledge skills that specialists can leverage.

### Project Grouping

After investigation, the CTO groups findings into Linear projects under the initiative:
- Searches existing active projects — reuses them where scope matches
- Creates new projects only for genuinely new themes (capped at 2 per session)
- Each finding brief includes the target project, so Issue Planners file into the right place

### Initiative Updates

At the end of each planning session, the CTO posts an initiative-level status update summarizing what was investigated, issues filed, projects created, and recommended next focus areas.

### Source files

| File | Purpose |
|------|---------|
| `src/planner.ts` | Module. `shouldRunPlanning()` checks threshold, `runPlanning()` runs the planning agent |
| `src/lib/prompt.ts` | `buildCTOPrompt()` renders CTO prompt |
| `prompts/cto.md` | CTO planning agent prompt |
| `plugins/planning-skills/agents/*.md` | Specialist agent definitions (briefing-agent, product-manager, scout, security-analyst, quality-engineer, architect, issue-planner, project-owner, technical-planner) |

---

## The Projects Loop

The projects loop manages project-level ownership. It polls active projects under the initiative for triage issues and spawns project-owner agents.

### Flow

```
Initiative
    |
    +---> list active projects (skip completed/canceled)
              |
              +---> for each project with triage issues:
                        |
                        +---> spawn Project Owner agent
                                    |
                                    +---> review triage queue (accept/defer)
                                    +---> spawn Technical Planners for accepted issues
                                    |         |
                                    |         +---> decompose into sub-issues (Ready)
                                    +---> check project health
                                    +---> complete project if all issues done
                                    +---> post project status update
```

### Project Lifecycle

Projects are created by the CTO during planning sessions and follow this lifecycle:

```
planned --> started --> completed
                   --> canceled
```

The project owner completes a project when all its issues are in Done or Canceled state and no triage issues remain.

### Source files

| File | Purpose |
|------|---------|
| `src/projects.ts` | Module. `checkProjects()` queries initiative projects and spawns owners |
| `plugins/planning-skills/agents/project-owner.md` | Project owner agent prompt |
| `plugins/planning-skills/agents/technical-planner.md` | Technical planner agent prompt |

---

## Web Dashboard

The dashboard is a Hono web server with htmx-powered live updates. It runs in the same process as the main loop.

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | HTML shell with inline CSS (dark theme, monospace), htmx from CDN |
| `GET /api/status` | JSON state dump (agents, history, queue, planning) |
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
| `src/state.ts` | `AppState` class — in-memory state for agents, history, queue, planning |

---

## Linear State Machine

The full Linear state machine across all loops:

```
                     +----------+
                     |  Triage  | <--- Planning files issues here
                     +----+-----+
                          |
              +-----------+-----------+
              |                       |
       project owner             human promotes
       accepts (if projects       (if no projects
       loop enabled)               loop)
              |                       |
              v                       |
     +--------+--------+             |
     | Technical Planner|             |
     | decomposes into  |             |
     | sub-issues       |             |
     +--------+--------+             |
              |                       |
              v                       v
         +----+-----+          +-----+----+
  +----> |  Ready   | <--------+  Ready   | <--- Executor pulls leaf issues
  |      |  (Todo)  |          |  (Todo)  |
  |      +----+-----+          +----+-----+
  |           |                      |
  |     executor picks up (team-wide, leaf issues only)
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
- **Human review**: PRs require human review before merge. The planning loop files to Triage (not Ready), requiring human promotion
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
| `linear` | Team key, project name, initiative name, state name mappings |
| `executor` | Parallelism, timeout, auto-approve labels, branch/commit patterns, model selection |
| `planning` | Schedule mode, backlog threshold, max issues per run, timeout |
| `projects` | Projects loop: enabled, poll interval, max active projects, timeout |
| `github` | Repo override, auto-merge |
| `project` | Project name |
| `sandbox` | OS-level sandbox config |

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

### Planning prompt flow

```
prompts/cto.md
plugins/planning-skills/agents/*.md  --- specialist agent definitions (auto-discovered by plugin)
        |
        v
buildCTOPrompt({ LINEAR_TEAM, LINEAR_PROJECT, ... })
        |
        v
CTO prompt + plugin path --> passed to Agent SDK query()
```

---

## Repository Structure

```
claude-autopilot/
├── src/
│   ├── main.ts              # Entry point — main loop + dashboard server
│   ├── executor.ts          # Executor module (executeIssue, fillSlots)
│   ├── planner.ts           # Planning module (shouldRunPlanning, runPlanning)
│   ├── projects.ts          # Projects loop (checkProjects, project owners)
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
│   ├── cto.md               # CTO planning agent prompt
│   ├── briefing-agent.md    # Briefing agent prompt
│   ├── scout.md             # Scout specialist prompt
│   ├── security-analyst.md  # Security Analyst specialist prompt
│   ├── quality-engineer.md  # Quality Engineer specialist prompt
│   ├── architect.md         # Architect specialist prompt
│   └── issue-planner.md     # Issue Planner subagent prompt
├── plugins/
│   └── planning-skills/     # Domain knowledge skills for planning
├── templates/
│   └── CLAUDE.md.template   # Template for target project's CLAUDE.md
├── docs/                    # Documentation
├── package.json             # Bun project config, npm scripts
└── tsconfig.json            # TypeScript configuration
```
