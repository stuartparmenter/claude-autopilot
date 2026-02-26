# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A fully autonomous AI development loop using Claude Code + Linear. Users clone this repo and point it at their own project repos. The toolkit provides:
- **Prompts** (`prompts/`) — the core product, defining what Claude Code agents do
- **TypeScript scripts** (Bun runtime) — orchestration plumbing
- **A web dashboard** (Hono + htmx) — live monitoring
- **Templates** (`templates/`) — for onboarding new projects

## Commands

```bash
bun install                  # Install dependencies
bun run start <project-path> # Start executor + monitor + planning + dashboard
bun run setup <project-path> # Onboard a new project

bun test                     # Run all tests (Bun test runner)
bun test src/lib/config.test.ts  # Run a single test file
bun test --watch             # Watch mode

bun run check                # Lint + format check (Biome)
bun run typecheck            # TypeScript type check (tsc --noEmit)
```

CI runs `typecheck`, `check`, and `bun test` on all PRs (`.github/workflows/lint.yml`, `.github/workflows/ci.yml`).

## Architecture

### Four Loops, One Entry Point

`bun run start` (`src/main.ts`) runs a single event loop that drives four subsystems:

1. **Executor** (`src/executor.ts`) — Pulls "Ready" leaf issues from Linear (team-wide, skipping parents with children), spawns Claude Code agents in isolated git worktrees. Each agent implements the issue, runs tests, pushes a PR, and updates Linear to "In Review". Runs up to `executor.parallel` agents concurrently.

2. **Monitor** (`src/monitor.ts`) — Checks "In Review" issues for CI failures or merge conflicts on their linked GitHub PRs. Spawns fixer agents to repair problems. Fixers check out the existing PR branch in a worktree and push fixes.

3. **Planning** (`src/planner.ts`) — When the backlog drops below `min_ready_threshold`, a CTO agent leads a team of specialists (PM, Scout, Security Analyst, Quality Engineer, Architect) to investigate the codebase. Groups findings into projects under the initiative, then spawns Issue Planner agents to file improvement issues to Linear. Posts initiative-level status updates.

4. **Projects** (`src/projects.ts`) — Polls active projects under the initiative for triage issues. Spawns project-owner agents that triage issues, spawn technical planners to decompose into sub-issues, monitor project health, and complete projects when all work is done.

### Linear Is the Source of Truth

Issue state transitions drive the system:
```
Planning → Triage → (Project Owner accepts) → Technical Planner → Ready (sub-issues)
                                                                      ↓
Ready → In Progress → In Review → Done
             ↓              ↓
          Blocked       (fixer loop)
```
The planning system writes to Triage. Project owners accept triage issues and spawn technical planners that decompose into Ready sub-issues. The executor reads Ready leaf issues (team-wide), moves to In Progress immediately (preventing double-pickup), then to In Review or Blocked. The monitor watches In Review.

### Key Modules

- **`src/projects.ts`** — Projects loop. `checkProjects()` queries active projects under the initiative for triage issues, spawns project-owner agents.
- **`src/lib/claude.ts`** — Wraps `@anthropic-ai/claude-agent-sdk` `query()`. Handles worktree creation/cleanup, timeout/inactivity watchdogs, activity streaming to `AppState`, and a **spawn gate** (sequential agent init to avoid `~/.claude.json` race conditions).
- **`src/lib/config.ts`** — Loads `.autopilot.yml` from the target project, deep-merges with `DEFAULTS`, validates string fields against injection.
- **`src/lib/linear.ts`** — Linear SDK wrapper. All calls use `withRetry()` for transient error resilience.
- **`src/lib/github.ts`** — Octokit wrapper. `detectRepo()` auto-detects owner/repo from git remote. `getPRStatus()` combines Checks API results.
- **`src/lib/prompt.ts`** — Loads `prompts/*.md` templates and substitutes `{{VARIABLE}}` placeholders with sanitized values.
- **`src/lib/worktree.ts`** — Creates/removes git worktrees at `.claude/worktrees/<name>`. Handles stale cleanup, Windows file lock retries.
- **`src/lib/retry.ts`** — `withRetry()` with exponential backoff + jitter, respects `Retry-After` headers.
- **`src/state.ts`** — In-memory `AppState` class tracking running agents, activity feeds, history, queue info, planning status.
- **`src/server.ts`** — Hono app serving the dashboard HTML shell and htmx partials. JSON API at `/api/status` and `/api/pause`.

### Agent Execution Flow

`runClaude()` in `src/lib/claude.ts` is the central agent runner:
1. Acquires spawn slot (serial init to avoid config race)
2. Creates worktree (executor: fresh branch from HEAD; fixer: existing PR branch)
3. Calls Agent SDK `query()` with `bypassPermissions` mode and Linear+GitHub MCP servers
4. Streams activity events to `AppState` for dashboard display
5. On completion/timeout/error: cleans up worktree, releases spawn slot

## Conventions

- **Template variables** use `{{VARIABLE}}` mustache syntax, substituted by `src/lib/prompt.ts`
- **Config** is YAML (`.autopilot.yml`) with typed defaults in `src/lib/config.ts`
- **All external API calls** (Linear, GitHub) use `withRetry()` from `src/lib/retry.ts`
- **MCP servers** (Linear + GitHub) are injected into agents via `buildMcpServers()` in `src/lib/claude.ts`
- **Tests** use Bun's built-in test runner, colocated as `*.test.ts` alongside source files
- **Formatting**: Biome with 2-space indent, double quotes, organized imports
- **Worktrees** live at `<project>/.claude/worktrees/<name>`; executor branches are `worktree-<issue-id>`, fixer branches are the PR branch itself

## Development Guidance

- **Prompt changes are the highest leverage.** The prompts in `prompts/` define what agents do — they're the real product. Scripts are plumbing.
- **Keep scripts simple.** Complex logic belongs in prompts, not TypeScript.
- **Linear SDK for deterministic work.** Querying, filtering, updating status — do this in TypeScript. Claude handles the creative parts.
