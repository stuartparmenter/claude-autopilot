import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityEntry } from "../state";
import { info, warn } from "./logger";

export interface ClaudeResult {
  result: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  timedOut: boolean;
  error?: string;
}

/**
 * Create a git worktree at the given path and return the absolute path.
 * If it already exists, returns the existing path.
 */
async function ensureWorktree(
  repoPath: string,
  worktreeName: string,
): Promise<string> {
  const worktreeDir = resolve(repoPath, ".claude", "worktrees", worktreeName);

  if (existsSync(worktreeDir)) {
    return worktreeDir;
  }

  // Create a new branch and worktree
  const branchName = `autopilot/${worktreeName}`;

  // Get the default branch
  const defaultBranch = Bun.spawnSync(
    ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const baseBranch =
    defaultBranch.exitCode === 0
      ? defaultBranch.stdout.toString().trim().replace("origin/", "")
      : "main";

  // Create worktree with a new branch
  const result = Bun.spawnSync(
    ["git", "worktree", "add", "-b", branchName, worktreeDir, baseBranch],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    // Branch might already exist, try without -b
    const retry = Bun.spawnSync(
      ["git", "worktree", "add", worktreeDir, branchName],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    if (retry.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${retry.stderr.toString()}`);
    }
  }

  return worktreeDir;
}

function summarizeToolUse(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
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
  timeoutMs?: number;
  model?: string;
  onActivity?: (entry: ActivityEntry) => void;
}): Promise<ClaudeResult> {
  // If a worktree is requested, create it and use its path as cwd
  let effectiveCwd = opts.cwd;
  if (opts.worktree) {
    info(`Setting up worktree: ${opts.worktree}`);
    effectiveCwd = await ensureWorktree(opts.cwd, opts.worktree);
    info(`Worktree ready at: ${effectiveCwd}`);
  }

  info(`Running Claude Code agent (cwd: ${effectiveCwd})...`);

  // Set up abort controller for timeout
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

  const emit = opts.onActivity;
  const result: ClaudeResult = {
    result: "",
    timedOut: false,
  };

  try {
    const queryOpts: Record<string, unknown> = {
      cwd: effectiveCwd,
      abortController: controller,
      // Use the full Claude Code toolkit and system prompt
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Load project settings (.claude/settings.json, CLAUDE.md)
      settingSources: ["project"],
      // Bypass all permission prompts for headless execution
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    if (opts.model) {
      queryOpts.model = opts.model;
    }

    for await (const message of query({
      prompt: opts.prompt,
      options: queryOpts,
    })) {
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
        const msg = message.message as {
          content?: Array<{
            type: string;
            name?: string;
            input?: unknown;
            text?: string;
          }>;
        };
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name) {
              emit?.({
                timestamp: Date.now(),
                type: "tool_use",
                summary: summarizeToolUse(block.name, block.input),
              });
            } else if (block.type === "text" && block.text) {
              emit?.({
                timestamp: Date.now(),
                type: "text",
                summary: block.text.slice(0, 120),
                detail: block.text,
              });
            }
          }
        }
      }

      // Emit activity for tool results
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
          const errors = (message as Record<string, unknown>).errors as
            | string[]
            | undefined;
          const errSummary = errors?.join("; ") ?? message.subtype;
          result.error = errSummary;
          emit?.({
            timestamp: Date.now(),
            type: "error",
            summary: `Agent error: ${errSummary.slice(0, 120)}`,
          });
        }
      }
    }
  } catch (e: unknown) {
    if (timedOut) {
      result.timedOut = true;
      result.error = "Timed out";
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: "Agent timed out",
      });
    } else {
      const errMsg = e instanceof Error ? e.message : String(e);
      result.error = errMsg;
      warn(`Claude Code error: ${errMsg}`);
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: `Error: ${errMsg.slice(0, 120)}`,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // The abort may end the stream without throwing, so ensure timedOut is captured
  result.timedOut = timedOut;

  if (!timedOut && !result.error) {
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
