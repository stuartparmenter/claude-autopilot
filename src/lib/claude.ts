import {
  query,
  type SDKAssistantMessage,
  type SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActivityEntry } from "../state";
import { info, warn } from "./logger";
import { createWorktree, removeWorktree } from "./worktree";

// Stagger agent spawns to avoid race conditions on ~/.claude.json.
// Each query() call waits for the previous one to finish starting up.
const SPAWN_DELAY_MS = 2000;
let spawnGate: Promise<void> = Promise.resolve();

function acquireSpawnSlot(): Promise<void> {
  const previous = spawnGate;
  let release: () => void;
  spawnGate = new Promise((r) => {
    release = r;
  });
  return previous.then(() => {
    setTimeout(() => release(), SPAWN_DELAY_MS);
  });
}

export interface ClaudeResult {
  result: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  timedOut: boolean;
  inactivityTimedOut: boolean;
  error?: string;
}

function summarizeToolUse(toolName: string, input: unknown): string {
  const inp =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  switch (toolName) {
    case "Read":
      return `Read ${inp.file_path ?? "file"}`;
    case "Write":
      return `Write ${inp.file_path ?? "file"}`;
    case "Edit":
      return `Edit ${inp.file_path ?? "file"}`;
    case "Bash":
      return `Bash: ${String(inp.command ?? "").slice(0, 80)}`;
    case "Glob":
      return `Glob: ${inp.pattern ?? ""}`;
    case "Grep":
      return `Grep: ${inp.pattern ?? ""}`;
    case "WebFetch":
      return `WebFetch: ${inp.url ?? ""}`;
    case "WebSearch":
      return `WebSearch: ${inp.query ?? ""}`;
    case "Task":
      return `Task: ${inp.description ?? inp.subagent_type ?? "subagent"}`;
    default:
      return `Tool: ${toolName}`;
  }
}

/**
 * Run Claude Code with the Agent SDK.
 * Sends a prompt, runs it against a codebase directory, and returns structured results.
 */
export async function runClaude(opts: {
  prompt: string;
  cwd: string;
  worktree?: string;
  worktreeBranch?: string;
  timeoutMs?: number;
  inactivityMs?: number;
  model?: string;
  mcpServers?: Record<string, unknown>;
  parentSignal?: AbortSignal;
  onActivity?: (entry: ActivityEntry) => void;
}): Promise<ClaudeResult> {
  info(`Running Claude Code agent (cwd: ${opts.cwd})...`);

  // Set up abort controller for timeout and graceful shutdown
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      warn(
        `Claude Code timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`,
      );
    }, opts.timeoutMs);
  }

  // If a parent signal fires (e.g. Ctrl+C), abort this agent too
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) {
      controller.abort();
    } else {
      opts.parentSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  const emit = opts.onActivity;
  const result: ClaudeResult = {
    result: "",
    timedOut: false,
    inactivityTimedOut: false,
  };

  // Hoist variables shared across try/catch/finally
  let worktreeCreated = false;
  let inactivityTimedOut = false;
  let loopCompleted = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityInterval: ReturnType<typeof setInterval> | undefined;

  try {
    const queryOpts: Record<string, unknown> = {
      cwd: opts.cwd,
      abortController: controller,
      // Use the full Claude Code toolkit and system prompt
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Load project settings (.claude/settings.json, CLAUDE.md)
      settingSources: ["project"],
      // Bypass all permission prompts for headless execution
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Capture stderr so we can diagnose startup failures (e.g. exit code 3)
      stderr: (data: string) => warn(`[stderr] ${data.trimEnd()}`),
    };
    if (opts.mcpServers) {
      queryOpts.mcpServers = opts.mcpServers;
    }
    if (opts.model) {
      queryOpts.model = opts.model;
    }
    // Self-managed worktrees: create before spawning, clean up in finally
    if (opts.worktree) {
      const wtPath = createWorktree(opts.cwd, opts.worktree, opts.worktreeBranch);
      queryOpts.cwd = wtPath;
      worktreeCreated = true;
    }

    // Check for shutdown before proceeding
    if (opts.parentSignal?.aborted) {
      if (worktreeCreated && opts.worktree) {
        removeWorktree(opts.cwd, opts.worktree, { keepBranch: !!opts.worktreeBranch });
      }
      result.error = "Aborted before start";
      return result;
    }

    // Wait for any prior agent to finish starting before we spawn
    await acquireSpawnSlot();

    // Inactivity watchdog: reset on every SDK message
    let lastActivityAt = Date.now();
    inactivityInterval = opts.inactivityMs
      ? setInterval(() => {
          if (inactivityTimedOut) return; // already fired
          if (Date.now() - lastActivityAt > opts.inactivityMs!) {
            inactivityTimedOut = true;
            warn(
              `Agent inactive for ${Math.round(opts.inactivityMs! / 1000)}s, aborting`,
            );
            controller.abort();
          }
        }, 30_000)
      : undefined;

    // Capture query object so we can call close() as a hard kill
    const q = query({ prompt: opts.prompt, options: queryOpts });

    const runSdkLoop = async () => {
      for await (const message of q) {
        // Reset inactivity watchdog on every message
        lastActivityAt = Date.now();

        // Capture session ID on init
        if (message.type === "system" && message.subtype === "init") {
          result.sessionId = message.session_id;
          emit?.({
            timestamp: Date.now(),
            type: "status",
            summary: "Agent started",
          });
        }

        // Emit activity for tool use
        if (message.type === "assistant" && message.message) {
          const { content } = (message as SDKAssistantMessage).message;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && "name" in block) {
                emit?.({
                  timestamp: Date.now(),
                  type: "tool_use",
                  summary: summarizeToolUse(block.name, block.input),
                });
              } else if (block.type === "text" && "text" in block) {
                emit?.({
                  timestamp: Date.now(),
                  type: "text",
                  summary: block.text.slice(0, 200),
                  detail: block.text,
                });
              }
            }
          }
        }

        // Capture result messages
        if (message.type === "result") {
          if (message.subtype === "success") {
            result.result = message.result;
            result.costUsd = message.total_cost_usd;
            result.durationMs = message.duration_ms;
            result.numTurns = message.num_turns;
            emit?.({
              timestamp: Date.now(),
              type: "result",
              summary: "Agent completed successfully",
            });
          } else {
            const errResult = message as SDKResultError;
            const errSummary = errResult.errors?.length
              ? errResult.errors.join("; ")
              : errResult.subtype;
            result.error = errSummary;
            emit?.({
              timestamp: Date.now(),
              type: "error",
              summary: `Agent error: ${errSummary.slice(0, 200)}`,
            });
          }
        }
      }
      loopCompleted = true;
    };

    // Hard kill safety net: if abort doesn't break the loop, force-close
    const effectiveTimeoutMs = Math.max(
      opts.timeoutMs ?? 30 * 60 * 1000,
      opts.inactivityMs ?? 10 * 60 * 1000,
    );
    const hardKillPromise = new Promise<"hard_kill">((resolve) => {
      hardKillTimer = setTimeout(
        () => resolve("hard_kill"),
        effectiveTimeoutMs + 60_000,
      );
    });

    const outcome = await Promise.race([
      runSdkLoop().then(() => "completed" as const),
      hardKillPromise,
    ]);

    if (outcome === "hard_kill") {
      warn("Hard kill: SDK loop did not exit after abort, forcing close");
      try {
        q.close();
      } catch {
        // close() may throw if already dead
      }
      if (!result.error) {
        result.error = "Hard kill: SDK unresponsive after abort";
      }
    }
  } catch (e: unknown) {
    if (timedOut || inactivityTimedOut) {
      result.error = inactivityTimedOut ? "Inactivity timeout" : "Timed out";
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: inactivityTimedOut
          ? "Agent inactive, timed out"
          : "Agent timed out",
      });
    } else {
      const errMsg = e instanceof Error ? e.message : String(e);
      result.error = errMsg;
      warn(`Claude Code error: ${errMsg}`);
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: `Error: ${errMsg.slice(0, 200)}`,
      });
    }
  } finally {
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (inactivityInterval) clearInterval(inactivityInterval);
    if (timer) clearTimeout(timer);

    if (worktreeCreated && opts.worktree) {
      try {
        removeWorktree(opts.cwd, opts.worktree, { keepBranch: !!opts.worktreeBranch });
      } catch (e) {
        warn(`Worktree cleanup failed for '${opts.worktree}': ${e}`);
      }
    }
  }

  // Only mark as timed out if the loop didn't complete successfully.
  // Fixes race where timeout fires milliseconds after the agent finishes.
  result.timedOut = (timedOut || inactivityTimedOut) && !loopCompleted;
  result.inactivityTimedOut = inactivityTimedOut && !loopCompleted;

  if (!result.timedOut && !result.error) {
    info(
      `Claude Code finished` +
        (result.durationMs
          ? ` in ${Math.round(result.durationMs / 1000)}s`
          : "") +
        (result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : "") +
        (result.numTurns ? ` (${result.numTurns} turns)` : ""),
    );
  }

  return result;
}
