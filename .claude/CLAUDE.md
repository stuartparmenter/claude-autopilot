# claude-autopilot

This is the claude-autopilot repository — an orchestration toolkit that creates a self-sustaining AI development loop using Claude Code + Linear + n8n.

## What This Repo Is

A reusable toolkit, not a hosted service. Users clone this repo and point it at their own project repos. The toolkit provides:
- **Prompts** (the core product) that tell Claude Code how to execute issues and audit codebases
- **TypeScript scripts** (Bun) that orchestrate the loop: query Linear, spawn Claude, update state
- **n8n workflows** for Phase 2 automation with parallelism and scheduling
- **Templates** for onboarding new projects

## Structure

```
prompts/          # Markdown prompt templates — the highest-leverage files
src/              # TypeScript scripts (Bun runtime)
  lib/            # Shared modules (config, linear, claude, prompt, logger)
  executor.ts     # Pulls Ready issues, spawns Claude, ships PRs
  auditor.ts      # Scans codebase, files improvement issues to Triage
  setup-project.ts # Onboards a new project
  test-loop.ts    # Creates test issues and validates setup
n8n/              # Importable n8n workflow JSON files
templates/        # Config and CLAUDE.md templates for target projects
docs/             # Architecture, onboarding, and tuning guides
```

## Conventions

- **Template variables** use `{{VARIABLE}}` mustache syntax, substituted at runtime by `src/lib/prompt.ts`
- **Config** is YAML (`.claude-autopilot.yml`) parsed by `src/lib/config.ts` with typed defaults
- **Linear API** is accessed via `@linear/sdk` in the TypeScript scripts; Claude Code agents use Linear MCP
- **Scripts** are run with `bun run <script-name>` and take project path as first argument
- **Headless Claude** uses `claude -p "{prompt}" --print` for non-interactive execution
- **Worktree isolation** uses `claude --worktree {name}` for parallel-safe execution

## Development Guidance

- **Prompt changes are the highest leverage.** The prompts define what Claude does — they're the real product. Scripts are just plumbing.
- **Keep scripts simple.** The TypeScript should be straightforward orchestration. Complex logic belongs in prompts.
- **Phase 1 must work without n8n.** Everything should be runnable with just `bun run executor <path>`. n8n adds parallelism and scheduling but is optional.
- **Linear SDK for deterministic work.** Querying issues, filtering, updating status — do this in TypeScript with proper types. Claude handles the creative parts.
- **Test with `bun run test-loop`.** Always validate changes end-to-end.
