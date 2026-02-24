import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
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

/**
 * Run Claude Code with the Agent SDK.
 * Sends a prompt, runs it against a codebase directory, and returns structured results.
 */
export async function runClaude(opts: {
  prompt: string;
  cwd: string;
  worktree?: string;
  timeoutMs?: number;
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

  const result: ClaudeResult = {
    result: "",
    timedOut: false,
  };

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: {
        cwd: effectiveCwd,
        allowedTools: [
          "Read",
          "Write",
          "Edit",
          "Bash",
          "Glob",
          "Grep",
          "WebFetch",
        ],
        permissionMode: "bypassPermissions",
      },
    })) {
      // Capture session ID on init
      if (message.type === "system" && message.subtype === "init") {
        result.sessionId = message.session_id;
      }

      // Capture the final result
      if (message.type === "result" && message.subtype === "success") {
        result.result = message.result;
        result.costUsd = message.total_cost_usd;
        result.durationMs = message.duration_ms;
        result.numTurns = message.num_turns;
      }
    }
  } catch (e: unknown) {
    if (timedOut) {
      result.timedOut = true;
      result.error = "Timed out";
    } else {
      const errMsg = e instanceof Error ? e.message : String(e);
      result.error = errMsg;
      warn(`Claude Code error: ${errMsg}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

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

/**
 * Check that the Claude Agent SDK / CLI is available.
 */
export async function checkClaudeCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
