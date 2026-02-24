# Design: claude-autopilot v2 — Loop + Dashboard

**Date**: 2026-02-23
**Status**: Approved

---

## Summary

Replace the n8n orchestration layer and standalone scripts with a single TypeScript process (`main.ts`) that runs the executor loop, auditor timer, and a web dashboard. Runs locally on the developer's machine.

```
bun run start /path/to/project
```

One command. Opens a local web dashboard showing live agent activity. Runs until Ctrl+C.

---

## Prerequisites

- **Bun** runtime
- **`LINEAR_API_KEY`** environment variable
- **Claude authentication** — one of:
  - **Max plan**: `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` to get it, or the SDK picks it up from Claude Code's existing auth)
  - **API billing**: `ANTHROPIC_API_KEY` from https://platform.claude.com/

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) bundles everything needed to run agent sessions programmatically. No separate Claude Code CLI install required.

---

## Architecture

Single process, three concerns:

```
src/main.ts
  ├── Executor loop
  │     Poll Linear → fill agent slots → await completions
  │
  ├── Auditor timer
  │     Every N hours, or when ready queue is empty
  │
  └── Hono web server (:7890)
        Dashboard with live agent activity
```

All state is in-memory. Linear is the source of truth. The dashboard is a live view of "what's happening right now." If the process restarts, state resets — but Linear still has all the issue history.

---

## Module Structure

```
src/
├── main.ts              # Entry point: starts executor, auditor, and server
├── executor.ts          # executeIssue() + slot-filling loop logic
├── auditor.ts           # runAudit() function
├── server.ts            # Hono app: routes + htmx partials
├── state.ts             # In-memory state store (agents, history, queue)
└── lib/
    ├── config.ts        # YAML config loader (existing)
    ├── linear.ts        # Linear SDK wrapper (existing)
    ├── claude.ts        # Agent SDK wrapper (updated to emit activity events)
    ├── prompt.ts        # Prompt template loader (existing)
    └── logger.ts        # Logger (existing)
```

---

## State Model (`state.ts`)

```typescript
interface AppState {
  agents: Map<string, AgentState>;   // running agents keyed by issue ID
  history: AgentResult[];            // completed agents (rolling buffer, last 50)
  queue: QueueInfo;                  // ready issue count, last poll time
  auditor: AuditorStatus;           // idle/running, next run time, last result
}

interface AgentState {
  issueId: string;
  issueIdentifier: string;          // e.g. "ENG-42"
  title: string;
  startedAt: Date;
  activity: ActivityEntry[];         // tool calls + assistant text
  status: "running" | "done" | "failed" | "timeout";
}

interface ActivityEntry {
  timestamp: Date;
  type: "tool" | "assistant" | "result" | "error";
  summary: string;                   // compact: "Read src/auth.ts"
  detail?: string;                   // verbose: full assistant text or tool output
}
```

---

## Agent SDK Integration (`claude.ts`)

The existing `runClaude()` collects messages silently and returns a final `ClaudeResult`. Updated to emit live activity via a callback:

```typescript
export async function runClaude(opts: {
  prompt: string;
  cwd: string;
  worktree?: string;
  timeoutMs?: number;
  onActivity?: (entry: ActivityEntry) => void;  // NEW
}): Promise<ClaudeResult>
```

Each message from the Agent SDK `query()` iterator is parsed into an `ActivityEntry` and emitted. Tool use messages become summaries like "Read src/auth.ts" or "Bash: npm test". Assistant text messages are captured as detail for the verbose view.

---

## Executor Loop

Configurable `max_parallel` (default 3). Fills slots as they free up.

```typescript
const MAX = config.executor.max_parallel;
const running = new Map<string, Promise<AgentResult>>();

while (true) {
  // Fill empty slots
  const issues = await getReadyIssues(..., MAX - running.size);
  for (const issue of issues) {
    if (running.has(issue.id)) continue;
    state.addAgent(issue);
    running.set(issue.id, executeIssue(issue, state));
  }

  // Wait for any to complete, or poll interval
  if (running.size > 0) {
    await Promise.race([...running.values(), sleep(pollInterval)]);
    // clean up completed, move to history
  } else {
    await sleep(pollInterval);
  }

  // Check auditor timer
  if (shouldRunAudit(state, config)) {
    runAudit(config, state);
  }
}
```

---

## Web Dashboard (`server.ts`)

Hono 4.12.2 + htmx 2.0.8. Server-rendered HTML, no build step. Localhost only, no auth needed.

### Routes

| Route | Purpose |
|-------|---------|
| `GET /` | Full dashboard page (HTML shell + htmx includes) |
| `GET /api/status` | JSON dump of full state (programmatic access) |
| `GET /partials/agents` | Agent cards — htmx polls every 3s |
| `GET /partials/agent/:id` | Single agent detail with activity feed |
| `GET /partials/history` | Completed agents list |
| `GET /partials/activity/:id` | Activity feed (default: tool summaries, `?verbose=true` for full text) |

### Dashboard Layout

```
┌─────────────────────────────────────────────────────────┐
│  claude-autopilot        Active: 2/3    Queue: 4 ready  │
├──────────┬──────────────────────────────────────────────┤
│ Agents   │  ENG-42 — Add auth middleware                │
│          │                                              │
│ ● ENG-42 │  ▸ Read  src/middleware/auth.ts              │
│   12m    │  ▸ Edit  src/middleware/auth.ts (+42 lines)  │
│ ● ENG-45 │  ▸ Bash  npm test                           │
│   3m     │    └ 14/14 tests passing                    │
│ ○ ───    │  ▸ Bash  git push origin autopilot/ENG-42   │
│          │                                    [verbose] │
├──────────┤                                              │
│ History  │                                              │
│ ✓ ENG-41 │                                              │
│ ✗ ENG-40 │                                              │
│ ✓ ENG-39 │                                              │
└──────────┴──────────────────────────────────────────────┘
```

Left sidebar: agent list + history. Main panel: selected agent's live activity feed. Verbose toggle expands to show full assistant reasoning text between tool calls.

---

## What Gets Deleted

- `n8n/` directory (auditor-workflow.json, executor-workflow.json, setup.md)
- Standalone script entry points replaced by `main.ts`
- All doc references to n8n, `claude -p`, `claude --worktree`, CLI prereqs

## What Gets Updated

- `docs/architecture.md` — single-process model, no n8n
- `.claude/CLAUDE.md` — remove n8n mentions, update conventions
- `README.md` — simplified prereqs (just Bun + LINEAR_API_KEY)
- `docs/adding-a-project.md` — remove Claude CLI install steps
- `docs/tuning.md` — remove n8n-specific tuning
- `package.json` — new scripts, new dependencies

## Dependencies

### Added
- `hono` ^4.12.2 — web framework (native Bun support)
- `htmx.org` ^2.0.8 — served as static JS for live UI updates

### Removed
- n8n (external system)

---

## Non-Goals (v2)

- Persistence across restarts (Linear is the source of truth)
- Multi-project support (one process per project)
- Authentication on the dashboard (localhost only)
- Docker/cloud deployment
- TUI (web UI only)
