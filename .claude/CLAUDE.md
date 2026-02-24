# claude-autopilot

This is the claude-autopilot repository — an orchestration toolkit that creates a self-sustaining AI development loop using Claude Code + Linear.

## What This Repo Is

A reusable toolkit, not a hosted service. Users clone this repo and point it at their own project repos. The toolkit provides:
- **Prompts** (the core product) that tell Claude Code how to execute issues and audit codebases
- **TypeScript scripts** (Bun) that orchestrate the loop: query Linear, spawn Claude agents, update state
- **A web dashboard** (Hono + htmx) for monitoring live agent activity
- **Templates** for onboarding new projects

## Structure

```
prompts/          # Markdown prompt templates — the highest-leverage files
src/              # TypeScript scripts (Bun runtime)
  lib/            # Shared modules (config, linear, claude, prompt, logger)
  main.ts         # Single entry point — runs executor loop + auditor + dashboard
  executor.ts     # Module: fills parallel agent slots for Ready issues
  auditor.ts      # Module: scans codebase, files improvement issues to Triage
  server.ts       # Hono web dashboard with htmx partials
  state.ts        # In-memory app state (agents, history, queue)
  setup-project.ts # Onboards a new project
templates/        # Config and CLAUDE.md templates for target projects
docs/             # Architecture, onboarding, and tuning guides
```

## Conventions

- **Template variables** use `{{VARIABLE}}` mustache syntax, substituted at runtime by `src/lib/prompt.ts`
- **Config** is YAML (`.claude-autopilot.yml`) parsed by `src/lib/config.ts` with typed defaults
- **Linear API** is accessed via `@linear/sdk` in the TypeScript scripts; Claude Code agents use Linear MCP
- **Single entry point**: `bun run start <project-path>` runs the executor loop, auditor, and web dashboard
- **Agent SDK** is used directly via `@anthropic-ai/claude-agent-sdk` `query()` in `src/lib/claude.ts`
- **Worktree isolation** uses git worktrees for parallel-safe execution

## Development Guidance

- **Prompt changes are the highest leverage.** The prompts define what Claude does — they're the real product. Scripts are just plumbing.
- **Keep scripts simple.** The TypeScript should be straightforward orchestration. Complex logic belongs in prompts.
- **Everything runs from `bun run start`.** The main loop handles parallelism, auditor scheduling, and the dashboard.
- **Linear SDK for deterministic work.** Querying issues, filtering, updating status — do this in TypeScript with proper types. Claude handles the creative parts.
