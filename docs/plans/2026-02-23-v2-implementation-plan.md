# v2 Loop + Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace n8n + standalone scripts with a single `main.ts` process that runs the executor loop, auditor timer, and Hono web dashboard.

**Architecture:** Single Bun process with three concurrent concerns: an executor loop that polls Linear and fills agent slots (configurable `max_parallel`), an auditor that runs on a timer, and a Hono HTTP server serving an htmx-powered dashboard showing live agent activity.

**Tech Stack:** Bun, TypeScript, Hono 4.12.2, htmx 2.0.8, Agent SDK, Linear SDK

---

### Task 1: Add dependencies and update package.json

**Files:**
- Modify: `package.json`

**Step 1: Add hono and htmx.org dependencies, update scripts**

```json
{
  "name": "claude-autopilot",
  "version": "0.2.0",
  "type": "module",
  "description": "Self-sustaining AI development loop using Claude Code + Linear",
  "scripts": {
    "start": "bun run src/main.ts",
    "setup": "bun run src/setup-project.ts",
    "check": "bunx biome check ./src",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.51",
    "@linear/sdk": "^75.0.0",
    "hono": "^4.12.2",
    "yaml": "^2.8.2"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.4",
    "@types/bun": "^1.3.9",
    "typescript": "^5.9.3"
  }
}
```

Note: `htmx.org` is served via CDN link in the HTML template, not installed as a package.

**Step 2: Install dependencies**

Run: `bun install`
Expected: Resolves successfully, `hono` added to `node_modules`

**Step 3: Verify typecheck still passes**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "feat: add hono, update scripts for v2 loop"
```

---

### Task 1.5: Add model config to ExecutorConfig

**Files:**
- Modify: `src/lib/config.ts`

**Step 1: Add model fields to ExecutorConfig**

Add two optional fields to `ExecutorConfig`:

```typescript
export interface ExecutorConfig {
  parallel: number;
  timeout_minutes: number;
  model: string;              // NEW — default model for execution (e.g. "sonnet")
  planning_model: string;     // NEW — model for planning phases (e.g. "opus")
  auto_approve_labels: string[];
  branch_pattern: string;
  commit_pattern: string;
}
```

Update the DEFAULTS:

```typescript
executor: {
  parallel: 3,
  timeout_minutes: 30,
  model: "sonnet",
  planning_model: "opus",
  auto_approve_labels: [],
  branch_pattern: "autopilot/{{id}}",
  commit_pattern: "{{id}}: {{title}}",
},
```

**Step 2: Pass model to `runClaude()` in executor**

The Agent SDK `query()` accepts a `model` option. Update `runClaude()` to accept and pass through an optional `model` parameter. The executor will use `config.executor.model` by default.

**Step 3: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: add configurable model selection (execution vs planning)"
```

---

### Task 2: Create state module (`src/state.ts`)

**Files:**
- Create: `src/state.ts`

**Step 1: Write the state module**

This is the in-memory store that the executor, auditor, and server all share. No tests needed — it's a plain data container.

```typescript
export interface ActivityEntry {
  timestamp: Date;
  type: "tool" | "assistant" | "result" | "error";
  summary: string;
  detail?: string;
}

export interface AgentState {
  issueId: string;
  issueIdentifier: string;
  title: string;
  startedAt: Date;
  activity: ActivityEntry[];
  status: "running" | "done" | "failed" | "timeout";
  costUsd?: number;
  prUrl?: string;
}

export interface AgentResult {
  issueId: string;
  issueIdentifier: string;
  title: string;
  startedAt: Date;
  finishedAt: Date;
  status: "done" | "failed" | "timeout";
  costUsd?: number;
  prUrl?: string;
  activityCount: number;
}

export interface QueueInfo {
  readyCount: number;
  lastPollAt: Date | null;
}

export interface AuditorStatus {
  status: "idle" | "running";
  nextRunAt: Date | null;
  lastResult?: {
    finishedAt: Date;
    issuesFiled: number;
    costUsd?: number;
  };
}

const MAX_HISTORY = 50;

export class AppState {
  agents = new Map<string, AgentState>();
  history: AgentResult[] = [];
  queue: QueueInfo = { readyCount: 0, lastPollAt: null };
  auditor: AuditorStatus = { status: "idle", nextRunAt: null };

  addAgent(issue: { id: string; identifier: string; title: string }): void {
    this.agents.set(issue.id, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: issue.title,
      startedAt: new Date(),
      activity: [],
      status: "running",
    });
  }

  addActivity(issueId: string, entry: ActivityEntry): void {
    const agent = this.agents.get(issueId);
    if (agent) {
      agent.activity.push(entry);
    }
  }

  completeAgent(
    issueId: string,
    status: "done" | "failed" | "timeout",
    extras?: { costUsd?: number; prUrl?: string },
  ): void {
    const agent = this.agents.get(issueId);
    if (!agent) return;

    agent.status = status;
    if (extras?.costUsd) agent.costUsd = extras.costUsd;
    if (extras?.prUrl) agent.prUrl = extras.prUrl;

    this.history.unshift({
      issueId: agent.issueId,
      issueIdentifier: agent.issueIdentifier,
      title: agent.title,
      startedAt: agent.startedAt,
      finishedAt: new Date(),
      status,
      costUsd: agent.costUsd,
      prUrl: agent.prUrl,
      activityCount: agent.activity.length,
    });

    if (this.history.length > MAX_HISTORY) {
      this.history.pop();
    }

    this.agents.delete(issueId);
  }

  toJSON() {
    return {
      agents: Object.fromEntries(this.agents),
      history: this.history,
      queue: this.queue,
      auditor: this.auditor,
    };
  }
}
```

**Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat: add in-memory state module"
```

---

### Task 3: Update `src/lib/claude.ts` to emit activity events

**Files:**
- Modify: `src/lib/claude.ts`

**Step 1: Add `onActivity` callback to `runClaude()`**

Update the `runClaude` function to accept an `onActivity` callback and emit `ActivityEntry` objects as the Agent SDK streams messages. Parse tool use messages into readable summaries (e.g., "Read src/auth.ts", "Bash: npm test"). Capture assistant text as `detail` for the verbose view.

Key changes:
- Add `onActivity?: (entry: ActivityEntry) => void` to the options
- Import `ActivityEntry` from `../state`
- Inside the `for await` loop over `query()` messages, parse each message type:
  - `assistant` messages with `tool_use` content: emit summary like `"Read src/auth.ts"` or `"Bash: npm test"`
  - `assistant` messages with `text` content: emit with `type: "assistant"`, text as `detail`
  - `result` messages: emit with `type: "result"`
  - Errors: emit with `type: "error"`

The existing `ClaudeResult` return value stays the same — `onActivity` is fire-and-forget.

**Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Run biome**

Run: `bunx biome check --write ./src`
Expected: Clean or auto-fixed

**Step 4: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat: emit live activity events from Agent SDK"
```

---

### Task 4: Rewrite `src/executor.ts` as a module (not a script)

**Files:**
- Modify: `src/executor.ts`

**Step 1: Convert to module with exported functions**

Remove all top-level script logic (arg parsing, `process.exit`, loop mode). Export two functions:

```typescript
import type { AppState, ActivityEntry } from "./state";
import type { AutopilotConfig } from "./lib/config";
import { runClaude } from "./lib/claude";
import { getReadyIssues, resolveLinearIds, updateIssue } from "./lib/linear";
import { buildPrompt } from "./lib/prompt";
import { info, ok, warn } from "./lib/logger";

interface ResolvedLinearIds {
  teamId: string;
  states: Record<string, string>;
}

/**
 * Execute a single issue. Returns when the agent finishes.
 */
export async function executeIssue(
  issue: { id: string; identifier: string; title: string },
  config: AutopilotConfig,
  linearIds: ResolvedLinearIds,
  projectPath: string,
  state: AppState,
): Promise<void> {
  // Build prompt, create worktree name, call runClaude with onActivity
  // that feeds state.addActivity(). On completion/failure/timeout,
  // call state.completeAgent() and updateIssue() in Linear.
}

/**
 * Fill available agent slots with ready issues.
 * Returns the promises for newly started agents.
 */
export async function fillSlots(
  config: AutopilotConfig,
  linearIds: ResolvedLinearIds,
  projectPath: string,
  state: AppState,
  running: Map<string, Promise<void>>,
): Promise<void> {
  const maxSlots = config.executor.parallel;
  const available = maxSlots - running.size;
  if (available <= 0) return;

  const issues = await getReadyIssues(
    linearIds.teamId,
    linearIds.states.ready,
    available,
  );
  state.queue.readyCount = issues.length;
  state.queue.lastPollAt = new Date();

  for (const issue of issues) {
    if (running.has(issue.id)) continue;
    state.addAgent({ id: issue.id, identifier: issue.identifier, title: issue.title });
    const promise = executeIssue(issue, config, linearIds, projectPath, state)
      .finally(() => running.delete(issue.id));
    running.set(issue.id, promise);
  }
}
```

**Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/executor.ts
git commit -m "refactor: convert executor to importable module"
```

---

### Task 5: Rewrite `src/auditor.ts` as a module (not a script)

**Files:**
- Modify: `src/auditor.ts`

**Step 1: Convert to module with exported function**

Remove top-level script logic. Export a single function:

```typescript
import type { AppState } from "./state";
import type { AutopilotConfig } from "./lib/config";
import { runClaude } from "./lib/claude";
import { countIssuesInState } from "./lib/linear";
import { buildAuditorPrompt } from "./lib/prompt";
import { info, ok, warn } from "./lib/logger";

interface ResolvedLinearIds {
  teamId: string;
  states: Record<string, string>;
}

/**
 * Run the auditor if conditions are met (backlog below threshold).
 * Updates state.auditor throughout.
 */
export async function runAudit(
  config: AutopilotConfig,
  linearIds: ResolvedLinearIds,
  projectPath: string,
  state: AppState,
): Promise<void> {
  // Check backlog threshold
  // Set state.auditor.status = "running"
  // Build prompt, call runClaude with onActivity
  // On completion, set state.auditor back to "idle" with lastResult
  // Schedule next run time
}

/**
 * Check if the auditor should run based on schedule and state.
 */
export function shouldRunAudit(
  config: AutopilotConfig,
  state: AppState,
): boolean {
  if (state.auditor.status === "running") return false;
  if (!state.auditor.nextRunAt) return true;
  return new Date() >= state.auditor.nextRunAt;
}
```

**Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/auditor.ts
git commit -m "refactor: convert auditor to importable module"
```

---

### Task 6: Create the Hono web server (`src/server.ts`)

**Files:**
- Create: `src/server.ts`

**Step 1: Write the server module**

Create a Hono app with the routes from the design doc. Uses template literal HTML — no JSX, no build step. htmx loaded from CDN (`https://unpkg.com/htmx.org@2.0.8`).

Routes:
- `GET /` — full dashboard HTML shell. Includes htmx. Sidebar has `hx-get="/partials/agents" hx-trigger="every 3s"` and `hx-get="/partials/history" hx-trigger="every 10s"`.
- `GET /api/status` — JSON dump of `state.toJSON()`
- `GET /partials/agents` — HTML fragment: list of running agent cards with status, elapsed time
- `GET /partials/agent/:id` — HTML fragment: agent detail with activity feed header
- `GET /partials/history` — HTML fragment: completed agents list
- `GET /partials/activity/:id` — HTML fragment: activity entries for an agent. Default shows tool summaries only. `?verbose=true` includes assistant text between tool calls.

The module exports a function that creates and returns the Hono app:

```typescript
import { Hono } from "hono";
import type { AppState } from "./state";

export function createServer(state: AppState): Hono {
  const app = new Hono();
  // ... routes that read from state
  return app;
}
```

CSS should be inline in the HTML shell — a simple dark theme with monospace fonts, similar to a terminal aesthetic. Keep it minimal.

**Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Run biome**

Run: `bunx biome check --write ./src`
Expected: Clean

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add Hono web dashboard with htmx"
```

---

### Task 7: Create `src/main.ts` entry point

**Files:**
- Create: `src/main.ts`

**Step 1: Write main.ts**

This is the entry point that wires everything together:

```typescript
import { loadConfig, resolveProjectPath } from "./lib/config";
import { resolveLinearIds } from "./lib/linear";
import { info, ok, error, header } from "./lib/logger";
import { AppState } from "./state";
import { fillSlots } from "./executor";
import { runAudit, shouldRunAudit } from "./auditor";
import { createServer } from "./server";

// --- Parse args ---
const projectPath = resolveProjectPath(process.argv[2]);
const port = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "7890");

// --- Load config and connect ---
const config = loadConfig(projectPath);
info(`Project: ${config.project.name}`);
info("Connecting to Linear...");
const linearIds = await resolveLinearIds(config.linear);
ok(`Connected — team ${config.linear.team}`);

// --- Initialize state ---
const state = new AppState();

// Set initial auditor schedule
const AUDITOR_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
state.auditor.nextRunAt = new Date(Date.now() + AUDITOR_INTERVAL_MS);

// --- Start web server ---
const app = createServer(state);
const server = Bun.serve({ port, fetch: app.fetch });
ok(`Dashboard: http://localhost:${port}`);

// --- Main loop ---
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const running = new Map<string, Promise<void>>();

header("claude-autopilot running");
info(`Executor: polling every ${POLL_INTERVAL_MS / 1000}s, max ${config.executor.parallel} parallel`);
info(`Auditor: next run at ${state.auditor.nextRunAt.toLocaleTimeString()}`);
info("Press Ctrl+C to stop");

while (true) {
  // Fill executor slots
  await fillSlots(config, linearIds, projectPath, state, running);

  // Check auditor
  if (shouldRunAudit(config, state)) {
    runAudit(config, linearIds, projectPath, state);
  }

  // Wait for any agent to complete or poll interval
  if (running.size > 0) {
    await Promise.race([
      ...running.values(),
      Bun.sleep(POLL_INTERVAL_MS),
    ]);
  } else {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}
```

**Step 2: Test it starts**

Run: `bun run src/main.ts --help` (should show usage since no project path)
Expected: Prints usage and exits

**Step 3: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 4: Run biome on everything**

Run: `bunx biome check --write ./src`
Expected: Clean

**Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: add main.ts entry point — single-process loop + dashboard"
```

---

### Task 8: Delete n8n directory and old scripts

**Files:**
- Delete: `n8n/auditor-workflow.json`
- Delete: `n8n/executor-workflow.json`
- Delete: `n8n/setup.md`
- Delete: `src/test-loop.ts`

**Step 1: Remove files**

```bash
rm -rf n8n/
rm src/test-loop.ts
```

**Step 2: Commit**

```bash
git add -A
git commit -m "chore: remove n8n workflows and test-loop script"
```

---

### Task 9: Update all documentation

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/adding-a-project.md`
- Modify: `docs/tuning.md`
- Modify: `src/setup-project.ts` (update next-steps output)

**Step 1: Update `.claude/CLAUDE.md`**

Remove all references to:
- n8n
- `claude -p` / `claude --print` / `claude --worktree`
- Headless Claude CLI
- Phase 1/Phase 2 distinction

Update:
- Description to mention "single-process loop with web dashboard"
- Structure section to reflect new module layout (no `n8n/` dir)
- Conventions to reference Agent SDK instead of CLI
- Scripts section: `bun run start <project-path>`

**Step 2: Update `README.md`**

- Remove n8n from description, prerequisites, and diagram
- Remove Claude Code CLI prerequisite
- Add prerequisites: Bun, LINEAR_API_KEY, Claude auth (Max OAuth or API key)
- Update quick start to use `bun run start`
- Update directory structure (no `n8n/`, show new files)

**Step 3: Update `docs/architecture.md`**

This is the biggest doc change. Rewrite to reflect single-process model:
- Remove all n8n references and the "Phase 2+: orchestrated" section
- Remove `claude -p` and `claude --worktree` references — replace with Agent SDK `query()`
- Update `src/lib/claude.ts` description: "Agent SDK wrapper" not "CLI wrapper"
- Simplify the scaling path: Phase 1 is the loop, Phase 2 is multi-project, Phase 3 is auto-approval
- Add a section about the web dashboard
- Update the repository structure diagram

**Step 4: Update `docs/adding-a-project.md`**

- Remove Claude Code CLI install prerequisite
- Remove `claude --version` check
- Update "Validate the setup" to use `bun run start` instead of `bun run test-loop`
- Update "Run the executor" to `bun run start <path>`
- Remove n8n MCP authentication section or simplify it

**Step 5: Update `docs/tuning.md`**

- Remove all n8n-specific tuning (workflow settings, Execute Command node, n8n parallelism)
- Update parallelism section to reference `executor.parallel` in config
- Keep the Claude-specific tuning (timeout, prompt tuning, cost)

**Step 6: Update `src/setup-project.ts` next-steps output**

Update the printed instructions at the end:
- Remove `bun run test-loop` step
- Replace `bun run executor` with `bun run start`
- Remove mention of Claude CLI authentication
- Add note about opening the dashboard URL

**Step 7: Verify all docs are consistent**

Grep for any remaining stale references:

Run: `grep -r "n8n\|claude -p\|claude --worktree\|--print\|test-loop\|bun run executor\|bun run auditor" docs/ src/ .claude/ README.md`
Expected: No matches

**Step 8: Run biome**

Run: `bunx biome check --write ./src`
Expected: Clean

**Step 9: Commit**

```bash
git add -A
git commit -m "docs: update all docs for v2 single-process architecture"
```

---

### Task 10: Final integration test and cleanup

**Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 2: Lint**

Run: `bunx biome check ./src`
Expected: Clean, no issues

**Step 3: Smoke test**

Run: `bun run start` (no args)
Expected: Prints usage message and exits

**Step 4: Verify the dashboard serves**

If a target project with `.claude-autopilot.yml` and `LINEAR_API_KEY` are available:

Run: `bun run start /path/to/project`
Expected:
- Prints "Connected — team ..."
- Prints "Dashboard: http://localhost:7890"
- Opening the URL in a browser shows the dashboard with empty agent list

If not available, verify the server starts by temporarily mocking — or skip this and rely on the previous steps passing.

**Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for v2"
```
