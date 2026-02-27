import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentDefinition,
  query,
  type SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActivityEntry } from "../state";
import { makeErrorActivity, processAgentMessage } from "./activity";
import {
  buildQueryOptions,
  buildSandboxConfig,
  buildSandboxGuardHook,
} from "./agent-config";
import type { SandboxConfig } from "./config";
import { info, warn } from "./logger";
import { AUTOPILOT_ROOT } from "./paths";
import { createClone, type GitIdentity, removeClone } from "./sandbox-clone";

/** Clone functions indirected through a mutable object so tests can replace them without mock.module(). */
export const _clone = { createClone, removeClone };

export { summarizeToolUse } from "./activity";
// Re-export for backward compatibility — callers import these from "./lib/claude"
export { buildAgentEnv, buildMcpServers } from "./agent-config";

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
export function acquireSpawnSlot(): {
  ready: Promise<void>;
  release: () => void;
} {
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

/** Reset the spawn gate to its initial resolved state. For use in tests only. */
export function resetSpawnGate(): void {
  spawnGate = Promise.resolve();
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
  rawMessages?: unknown[];
}

/**
 * Run Claude Code with the Agent SDK.
 * Sends a prompt, runs it against a codebase directory, and returns structured results.
 */
export async function runClaude(opts: {
  prompt: string | ((branch: string) => string);
  cwd: string;
  label?: string;
  clone?: string;
  cloneBranch?: string;
  gitIdentity?: GitIdentity;
  timeoutMs?: number;
  inactivityMs?: number;
  model?: string;
  sandbox?: SandboxConfig;
  agents?: Record<string, AgentDefinition>;
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

  let cloneName: string | undefined;
  let agentTmpDir: string | undefined;
  let inactivityTimedOut = false;
  let loopCompleted = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityInterval: ReturnType<typeof setInterval> | undefined;
  let releaseSpawnSlot: (() => void) | undefined;
  let activeQuery: { close(): void } | undefined;

  try {
    const queryOpts = buildQueryOptions(
      opts.cwd,
      controller,
      (data: string) => warn(`${tag}[stderr] ${data.trimEnd()}`),
      {
        mcpServers: opts.mcpServers,
        model: opts.model,
        agents: opts.agents,
        plugins: opts.plugins,
      },
    );

    // Inject autopilot plugin: fixes sandbox TMPDIR issues via SessionStart hook.
    // Applied to all agents — must be present before sandbox config is set.
    const autopilotPlugin: SdkPluginConfig = {
      type: "local",
      path: resolve(AUTOPILOT_ROOT, "plugins/autopilot"),
    };
    const basePlugins = (queryOpts.plugins ?? []) as SdkPluginConfig[];
    queryOpts.plugins = [...basePlugins, autopilotPlugin];

    // Sandbox isolation: restrict agent filesystem and optionally network access
    if (opts.sandbox?.enabled) {
      // Create a dedicated temp directory for this agent and add it to
      // the sandbox allowWrite list so it's writable inside bubblewrap.
      // CLAUDE_CODE_TMPDIR tells Claude Code where to put internal temp files.
      // AUTOPILOT_TMPDIR is read by the executor plugin's SessionStart hook
      // which writes the correct TMPDIR to CLAUDE_ENV_FILE for Bash calls.
      agentTmpDir = mkdtempSync(join(tmpdir(), "claude-agent-"));
      queryOpts.env = {
        ...(queryOpts.env as Record<string, string>),
        CLAUDE_CODE_TMPDIR: agentTmpDir,
        AUTOPILOT_TMPDIR: agentTmpDir,
      };
      queryOpts.sandbox = buildSandboxConfig(opts.sandbox, agentTmpDir);

      // Sandbox guard: deny Write/Edit to paths outside cwd and /tmp.
      // Programmatic hook replaces the shell plugin so denials are logged.
      // See: https://github.com/anthropics/claude-code/issues/29048
      queryOpts.hooks = buildSandboxGuardHook(opts.cwd);
    }

    // Self-managed clones: create before spawning, clean up in finally
    if (opts.clone) {
      const cloneResult = await _clone.createClone(
        opts.cwd,
        opts.clone,
        opts.cloneBranch,
        opts.gitIdentity,
      );
      queryOpts.cwd = cloneResult.path;
      cloneName = opts.clone;

      // If prompt is a builder function, resolve it now that we know the branch
      if (typeof opts.prompt === "function") {
        opts.prompt = opts.prompt(cloneResult.branch);
      }
    }

    // Check for shutdown before proceeding
    if (opts.parentSignal?.aborted) {
      if (cloneName) {
        await _clone.removeClone(opts.cwd, cloneName);
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

    const resolvedPrompt =
      typeof opts.prompt === "function"
        ? (() => {
            throw new Error("Prompt builder was not resolved before query()");
          })()
        : opts.prompt;
    const q = query({ prompt: resolvedPrompt, options: queryOpts });
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

    const rawMessages: unknown[] = [];

    const runSdkLoop = async () => {
      for await (const message of q) {
        lastActivityAt = Date.now();
        rawMessages.push(message);

        const processed = processAgentMessage(message, queryOpts.cwd as string);

        for (const entry of processed.activities) {
          emit?.(entry);
        }

        if (processed.sessionId !== undefined) {
          result.sessionId = processed.sessionId;
          releaseSpawnSlot?.();
        }

        if (processed.successResult) {
          result.result = processed.successResult.result;
          result.costUsd = processed.successResult.costUsd;
          result.durationMs = processed.successResult.durationMs;
          result.numTurns = processed.successResult.numTurns;
        }

        if (processed.errorMessage !== undefined) {
          result.error = processed.errorMessage;
        }
      }
      loopCompleted = true;
      result.rawMessages = rawMessages;
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
      emit?.(
        makeErrorActivity(
          inactivityTimedOut ? "Agent inactive, timed out" : "Agent timed out",
        ),
      );
    } else if (opts.parentSignal?.aborted) {
      result.error = "Aborted (shutdown)";
      emit?.(makeErrorActivity("Agent aborted (shutdown)"));
    } else {
      const errMsg = e instanceof Error ? e.message : String(e);
      result.error = errMsg;
      warn(`${tag}Claude Code error: ${errMsg}`);
      emit?.(makeErrorActivity(`Error: ${errMsg.slice(0, 200)}`));
    }
  } finally {
    if (activeQuery) activeQueries.delete(activeQuery);
    // Ensure the spawn slot is released even if we never got to init
    releaseSpawnSlot?.();
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (inactivityInterval) clearInterval(inactivityInterval);
    if (timer) clearTimeout(timer);

    if (agentTmpDir) {
      try {
        rmSync(agentTmpDir, { recursive: true, force: true });
      } catch (e) {
        warn(`${tag}Failed to clean up agent temp dir '${agentTmpDir}': ${e}`);
      }
    }

    if (cloneName) {
      try {
        await _clone.removeClone(opts.cwd, cloneName);
      } catch (e) {
        warn(`${tag}Clone cleanup failed for '${cloneName}': ${e}`);
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
