import { resolve } from "node:path";
import {
  type AgentDefinition,
  createSdkMcpServer,
  query,
  type SDKAssistantMessage,
  type SDKResultError,
  type SdkPluginConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ActivityEntry } from "../state";
import type { SandboxConfig } from "./config";
import { enableAutoMerge } from "./github";
import { info, warn } from "./logger";
import { createWorktree, removeWorktree } from "./worktree";

/** Domains agents always need access to when network is restricted. */
const SANDBOX_BASE_DOMAINS = [
  "github.com",
  "api.github.com",
  "api.githubcopilot.com",
  "mcp.linear.app",
];

// Active Query handles — used by closeAllAgents() to forcefully kill
// child processes on shutdown (sync SIGTERM + 5s SIGKILL escalation).
const activeQueries = new Set<{ close(): void }>();

/**
 * Synchronously close all running agent subprocesses.
 * Call this from process signal handlers — close() is sync and sends
 * SIGTERM immediately, escalating to SIGKILL after 5s.
 */
export function closeAllAgents(): void {
  for (const q of activeQueries) {
    try {
      q.close();
    } catch {
      // close() may throw if already dead
    }
  }
}

// Stagger agent spawns to avoid race conditions on ~/.claude.json.
// Each query() waits for the previous agent's init message before spawning.
// If the agent crashes before init, the finally block releases the slot.
let spawnGate: Promise<void> = Promise.resolve();

/**
 * Wait for the previous agent to finish starting, then reserve the slot.
 * Returns a release function — call it when the agent emits its init message,
 * or in the finally block if the agent never starts.
 */
function acquireSpawnSlot(): { ready: Promise<void>; release: () => void } {
  const previous = spawnGate;
  let release!: () => void;
  let released = false;
  spawnGate = new Promise<void>((r) => {
    release = () => {
      if (!released) {
        released = true;
        r();
      }
    };
  });
  return { ready: previous, release };
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

/** Maps tool names to the input field used in their activity summary. */
const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
};

function summarizeToolUse(
  toolName: string,
  input: unknown,
  cwd?: string,
): string {
  const inp =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  const field = TOOL_SUMMARY_FIELDS[toolName];
  if (field) {
    let value = String(inp[field] ?? "");
    if (cwd && value.startsWith(cwd)) {
      value = value.slice(cwd.length).replace(/^\//, "");
    }
    return `${toolName}: ${value}`;
  }
  if (toolName === "Task") {
    return `Task: ${inp.description ?? inp.subagent_type ?? "subagent"}`;
  }
  return `Tool: ${toolName}`;
}

export function buildMcpServers(): Record<string, unknown> {
  const autoMergeTool = tool(
    "enable_auto_merge",
    "Enable auto-merge on a GitHub pull request. Automatically detects the repo's allowed merge method. Requires the repo to have auto-merge enabled and branch protection rules configured.",
    {
      owner: z.string().describe("Repository owner (e.g. 'octocat')"),
      repo: z.string().describe("Repository name (e.g. 'hello-world')"),
      pull_number: z.number().describe("Pull request number"),
    },
    async (args) => {
      const msg = await enableAutoMerge(
        args.owner,
        args.repo,
        args.pull_number,
      );
      return { content: [{ type: "text" as const, text: msg }] };
    },
  );

  return {
    linear: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer ${process.env.LINEAR_API_KEY}` },
    },
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
    },
    autopilot: createSdkMcpServer({
      name: "autopilot",
      tools: [autoMergeTool],
    }),
  };
}

/**
 * Run Claude Code with the Agent SDK.
 * Sends a prompt, runs it against a codebase directory, and returns structured results.
 */
export async function runClaude(opts: {
  prompt: string;
  cwd: string;
  label?: string;
  worktree?: string;
  worktreeBranch?: string;
  timeoutMs?: number;
  inactivityMs?: number;
  model?: string;
  sandbox?: SandboxConfig;
  agents?: Record<string, AgentDefinition>;
  tools?: string[];
  plugins?: SdkPluginConfig[];
  mcpServers?: Record<string, unknown>;
  parentSignal?: AbortSignal;
  onControllerReady?: (controller: AbortController) => void;
  onActivity?: (entry: ActivityEntry) => void;
}): Promise<ClaudeResult> {
  const tag = opts.label ? `[${opts.label}] ` : "";
  info(`${tag}Running Claude Code agent (cwd: ${opts.cwd})...`);

  const controller = new AbortController();
  opts.onControllerReady?.(controller);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (opts.timeoutMs) {
    const timeoutMs = opts.timeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      warn(
        `${tag}Claude Code timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    }, timeoutMs);
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

  let worktreeName: string | undefined;
  let inactivityTimedOut = false;
  let loopCompleted = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityInterval: ReturnType<typeof setInterval> | undefined;
  let releaseSpawnSlot: (() => void) | undefined;
  let activeQuery: { close(): void } | undefined;

  const keepBranch = !!opts.worktreeBranch;

  try {
    // Build query options declaratively
    const queryOpts: Record<string, unknown> = {
      cwd: opts.cwd,
      abortController: controller,
      tools: opts.tools ?? { type: "preset", preset: "claude_code" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      stderr: (data: string) => warn(`${tag}[stderr] ${data.trimEnd()}`),
      env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
      ...(opts.mcpServers && { mcpServers: opts.mcpServers }),
      ...(opts.model && { model: opts.model }),
      ...(opts.agents && { agents: opts.agents }),
      ...(opts.plugins && { plugins: opts.plugins }),
      // NOTE: SDK Setup hooks don't fire reliably for programmatic callbacks,
      // so we release the spawn slot on the init stream message instead (below).
    };

    // Sandbox isolation: restrict agent filesystem and optionally network access
    if (opts.sandbox?.enabled) {
      const sandbox: Record<string, unknown> = {
        enabled: true,
        autoAllowBashIfSandboxed: opts.sandbox.auto_allow_bash ?? true,
        allowUnsandboxedCommands: false,
        filesystem: {
          allowWrite: [
            // Git worktrees share the parent repo's .git directory
            resolve(opts.cwd, ".git"),
            // Allow /tmp for Claude Code internals, git, bun, ssh-keygen, etc.
            // Per-agent TMPDIR scoping is blocked by SDK overriding env vars:
            // https://github.com/anthropics/claude-code/issues/15700
            "/tmp",
          ],
        },
      };
      if (opts.sandbox.network_restricted) {
        const network: Record<string, unknown> = {
          allowedDomains: [
            ...SANDBOX_BASE_DOMAINS,
            ...(opts.sandbox.extra_allowed_domains ?? []),
          ],
        };
        // Allow SSH agent socket for git commit signing
        if (process.env.SSH_AUTH_SOCK) {
          network.allowUnixSockets = [process.env.SSH_AUTH_SOCK];
        }
        sandbox.network = network;
      }
      queryOpts.sandbox = sandbox;
    }

    // Self-managed worktrees: create before spawning, clean up in finally
    if (opts.worktree) {
      queryOpts.cwd = await createWorktree(
        opts.cwd,
        opts.worktree,
        opts.worktreeBranch,
      );
      worktreeName = opts.worktree;
    }

    // Check for shutdown before proceeding
    if (opts.parentSignal?.aborted) {
      if (worktreeName) {
        await removeWorktree(opts.cwd, worktreeName, { keepBranch });
      }
      result.error = "Aborted before start";
      return result;
    }

    // Wait for any prior agent to finish starting before we spawn
    const spawnSlot = acquireSpawnSlot();
    releaseSpawnSlot = spawnSlot.release;
    await spawnSlot.ready;

    // Inactivity watchdog: reset on every SDK message
    let lastActivityAt = Date.now();
    if (opts.inactivityMs) {
      const inactivityMs = opts.inactivityMs;
      inactivityInterval = setInterval(() => {
        if (inactivityTimedOut) return;
        if (Date.now() - lastActivityAt > inactivityMs) {
          inactivityTimedOut = true;
          warn(
            `${tag}Agent inactive for ${Math.round(inactivityMs / 1000)}s, aborting`,
          );
          controller.abort();
        }
      }, 30_000);
    }

    const q = query({ prompt: opts.prompt, options: queryOpts });
    activeQuery = q;
    activeQueries.add(q);

    // If the parent signal fires after q exists, close() directly —
    // this sends SIGTERM and escalates to SIGKILL after 5s, unlike
    // abort() which only asks the SDK to stop politely.
    const onParentAbort = () => {
      try {
        q.close();
      } catch {
        // already dead
      }
    };
    if (opts.parentSignal?.aborted) {
      onParentAbort();
    } else {
      opts.parentSignal?.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }

    const runSdkLoop = async () => {
      for await (const message of q) {
        lastActivityAt = Date.now();

        if (message.type === "system" && message.subtype === "init") {
          result.sessionId = message.session_id;
          releaseSpawnSlot?.();
          emit?.({
            timestamp: Date.now(),
            type: "status",
            summary: "Agent started",
          });
        }

        if (message.type === "assistant" && message.message) {
          const { content } = (message as SDKAssistantMessage).message;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && "name" in block) {
                emit?.({
                  timestamp: Date.now(),
                  type: "tool_use",
                  summary: summarizeToolUse(
                    block.name,
                    block.input,
                    queryOpts.cwd as string,
                  ),
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

    // Hard kill safety net: if the SDK async iterator doesn't exit
    // within 15s of an abort/close, force-close and break the loop.
    // This only arms once the controller is actually aborted.
    const hardKillPromise = new Promise<"hard_kill">((resolve) => {
      const arm = () => {
        hardKillTimer = setTimeout(() => resolve("hard_kill"), 15_000);
      };
      if (controller.signal.aborted) {
        arm();
      } else {
        controller.signal.addEventListener("abort", arm, { once: true });
      }
    });

    const outcome = await Promise.race([
      runSdkLoop().then(() => "completed" as const),
      hardKillPromise,
    ]);

    if (outcome === "hard_kill") {
      warn(`${tag}Hard kill: SDK loop did not exit after abort, forcing close`);
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
    } else if (opts.parentSignal?.aborted) {
      result.error = "Aborted (shutdown)";
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: "Agent aborted (shutdown)",
      });
    } else {
      const errMsg = e instanceof Error ? e.message : String(e);
      result.error = errMsg;
      warn(`${tag}Claude Code error: ${errMsg}`);
      emit?.({
        timestamp: Date.now(),
        type: "error",
        summary: `Error: ${errMsg.slice(0, 200)}`,
      });
    }
  } finally {
    if (activeQuery) activeQueries.delete(activeQuery);
    // Ensure the spawn slot is released even if we never got to init
    releaseSpawnSlot?.();
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (inactivityInterval) clearInterval(inactivityInterval);
    if (timer) clearTimeout(timer);

    if (worktreeName) {
      try {
        await removeWorktree(opts.cwd, worktreeName, { keepBranch });
      } catch (e) {
        warn(`${tag}Worktree cleanup failed for '${worktreeName}': ${e}`);
      }
    }
  }

  // Only mark as timed out if the loop didn't complete successfully.
  // Fixes race where timeout fires milliseconds after the agent finishes.
  result.timedOut = (timedOut || inactivityTimedOut) && !loopCompleted;
  result.inactivityTimedOut = inactivityTimedOut && !loopCompleted;

  if (!result.timedOut && !result.error) {
    info(
      `${tag}Claude Code finished` +
        (result.durationMs
          ? ` in ${Math.round(result.durationMs / 1000)}s`
          : "") +
        (result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : "") +
        (result.numTurns ? ` (${result.numTurns} turns)` : ""),
    );
  }

  return result;
}
