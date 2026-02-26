import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ActivityEntry } from "../state";

// ─── Environment setup ───────────────────────────────────────────────────────
// Required by buildMcpServers() to construct Authorization headers
process.env.LINEAR_API_KEY = "test-linear-key";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Mutable mock state ──────────────────────────────────────────────────────
// Mutated per-test; the mock query function snapshots state at call time.
let queryMessages: unknown[] = [];
let queryBehavior: "normal" | "abort_throw" = "normal";
let queryError: Error | null = null;

const mockClose = mock(() => {});

const mockCreateWorktree = mock(
  (_cwd: string, _name: string, _branch?: string) =>
    Promise.resolve("/fake/worktree"),
);
const mockRemoveWorktree = mock(
  (_cwd: string, _name: string, _opts?: { keepBranch?: boolean }) =>
    Promise.resolve(),
);

const mockQuery = mock(
  (callOpts: { prompt: string; options: Record<string, unknown> }) => {
    const signal = (
      callOpts.options?.abortController as AbortController | undefined
    )?.signal;
    const msgs = [...queryMessages];
    const err = queryError;
    const behavior = queryBehavior;

    async function* gen() {
      if (err) throw err;
      if (behavior === "abort_throw") {
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(
              Object.assign(new Error("AbortError"), { name: "AbortError" }),
            );
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error("AbortError"), { name: "AbortError" }),
              );
            },
            { once: true },
          );
        });
        return;
      }
      for (const msg of msgs) {
        yield msg;
      }
    }

    return Object.assign(gen(), { close: mockClose });
  },
);

// ─── Module mocks ────────────────────────────────────────────────────────────
// Must be at top level so Bun processes them before static imports resolve.
// Only mock external modules here — internal modules (./worktree, ./logger, ./github)
// must NOT be mocked via mock.module() because it causes permanent cross-file leakage
// (Bun bug #7823). Worktree is injected via _worktree instead (see beforeEach below).

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  createSdkMcpServer: (_config: unknown) => ({ type: "sdk-mcp" }),
  tool: (_name: string, _desc: string, _schema: unknown, fn: unknown) => ({
    name: _name,
    fn,
  }),
}));

import {
  _worktree,
  acquireSpawnSlot,
  buildMcpServers,
  resetSpawnGate,
  runClaude,
  summarizeToolUse,
} from "./claude";

// Capture real worktree functions before tests replace them
const origCreateWorktree = _worktree.createWorktree;
const origRemoveWorktree = _worktree.removeWorktree;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInitMessage(sessionId = "sess-1") {
  return { type: "system", subtype: "init", session_id: sessionId };
}

function makeAssistantMessage(content: unknown[]) {
  return { type: "assistant", message: { content } };
}

function makeSuccessResult(
  overrides: Partial<{
    result: string;
    total_cost_usd: number;
    duration_ms: number;
    num_turns: number;
  }> = {},
) {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.5,
    duration_ms: 2000,
    num_turns: 5,
    ...overrides,
  };
}

function makeErrorResult(errors?: string[], subtype = "error_with_output") {
  return { type: "result", subtype, errors };
}

function baseOpts() {
  return { prompt: "test prompt", cwd: "/test/cwd", label: "test" };
}

beforeEach(() => {
  queryMessages = [];
  queryBehavior = "normal";
  queryError = null;
  mockClose.mockClear();
  mockCreateWorktree.mockClear();
  mockRemoveWorktree.mockClear();
  mockQuery.mockClear();
  resetSpawnGate();
  // Inject mock worktree functions via the exported indirection object so we
  // don't need mock.module("./worktree") which leaks into other test files.
  _worktree.createWorktree =
    mockCreateWorktree as unknown as typeof _worktree.createWorktree;
  _worktree.removeWorktree =
    mockRemoveWorktree as unknown as typeof _worktree.removeWorktree;
});

afterEach(() => {
  // Restore real worktree functions so other test files are not affected.
  _worktree.createWorktree = origCreateWorktree;
  _worktree.removeWorktree = origRemoveWorktree;
});

// ─── summarizeToolUse ────────────────────────────────────────────────────────

describe("summarizeToolUse", () => {
  test("Read tool uses file_path field", () => {
    expect(summarizeToolUse("Read", { file_path: "/src/foo.ts" })).toBe(
      "Read: /src/foo.ts",
    );
  });

  test("Bash tool uses command field", () => {
    expect(summarizeToolUse("Bash", { command: "bun test" })).toBe(
      "Bash: bun test",
    );
  });

  test("Glob tool uses pattern field", () => {
    expect(summarizeToolUse("Glob", { pattern: "**/*.ts" })).toBe(
      "Glob: **/*.ts",
    );
  });

  test("Grep tool uses pattern field", () => {
    expect(summarizeToolUse("Grep", { pattern: "function \\w+" })).toBe(
      "Grep: function \\w+",
    );
  });

  test("strips cwd prefix from value when cwd matches", () => {
    expect(
      summarizeToolUse(
        "Read",
        { file_path: "/project/src/foo.ts" },
        "/project",
      ),
    ).toBe("Read: src/foo.ts");
  });

  test("long values are returned in full (no truncation)", () => {
    const longPath = `/project/${"a".repeat(100)}.ts`;
    expect(summarizeToolUse("Read", { file_path: longPath })).toBe(
      `Read: ${longPath}`,
    );
  });

  test("Task tool uses description when present", () => {
    expect(
      summarizeToolUse("Task", {
        description: "run tests",
        subagent_type: "general-purpose",
      }),
    ).toBe("Task: run tests");
  });

  test("Task tool falls back to subagent_type when no description", () => {
    expect(summarizeToolUse("Task", { subagent_type: "general-purpose" })).toBe(
      "Task: general-purpose",
    );
  });

  test("Task tool falls back to 'subagent' when neither field present", () => {
    expect(summarizeToolUse("Task", {})).toBe("Task: subagent");
  });

  test("unknown tool returns 'Tool: <name>'", () => {
    expect(summarizeToolUse("UnknownTool", { something: "value" })).toBe(
      "Tool: UnknownTool",
    );
  });

  test("null input is treated as empty object", () => {
    expect(summarizeToolUse("Read", null)).toBe("Read: ");
  });

  test("non-object input is treated as empty object", () => {
    expect(summarizeToolUse("Bash", 42)).toBe("Bash: ");
  });
});

// ─── buildMcpServers ─────────────────────────────────────────────────────────

describe("buildMcpServers", () => {
  test("linear and github entries have type 'http'", () => {
    const servers = buildMcpServers();
    expect((servers.linear as Record<string, unknown>).type).toBe("http");
    expect((servers.github as Record<string, unknown>).type).toBe("http");
  });

  test("linear uses correct URL and LINEAR_API_KEY bearer token", () => {
    const servers = buildMcpServers();
    const linear = servers.linear as Record<string, unknown>;
    expect(linear.url).toBe("https://mcp.linear.app/mcp");
    expect((linear.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-linear-key",
    );
  });

  test("github uses correct URL and GITHUB_TOKEN bearer token", () => {
    const servers = buildMcpServers();
    const github = servers.github as Record<string, unknown>;
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/");
    expect((github.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-github-token",
    );
  });
});

// ─── acquireSpawnSlot ────────────────────────────────────────────────────────

describe("acquireSpawnSlot", () => {
  test("first slot's ready resolves immediately", async () => {
    const { ready } = acquireSpawnSlot();
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  test("second slot waits for first to release", async () => {
    const first = acquireSpawnSlot();
    const second = acquireSpawnSlot();
    let secondReady = false;
    second.ready.then(() => {
      secondReady = true;
    });

    await Promise.resolve();
    expect(secondReady).toBe(false);

    first.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondReady).toBe(true);
  });

  test("double release is idempotent", async () => {
    const { ready, release } = acquireSpawnSlot();
    await ready;
    release();
    release(); // should not throw or double-resolve

    const next = acquireSpawnSlot();
    let nextResolved = false;
    next.ready.then(() => {
      nextResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(nextResolved).toBe(true);
  });

  test("chain of 3 slots serializes correctly", async () => {
    const order: number[] = [];

    const first = acquireSpawnSlot();
    const second = acquireSpawnSlot();
    const third = acquireSpawnSlot();

    first.ready.then(() => order.push(1));
    second.ready.then(() => order.push(2));
    third.ready.then(() => order.push(3));

    await Promise.resolve();
    expect(order).toEqual([1]);

    first.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    second.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2, 3]);
  });
});

// ─── runClaude — success path ─────────────────────────────────────────────────

describe("runClaude — success path", () => {
  beforeEach(() => {
    queryMessages = [
      makeInitMessage("sess-abc"),
      makeAssistantMessage([
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/test/foo.ts" },
        },
      ]),
      makeAssistantMessage([{ type: "text", text: "I read the file." }]),
      makeSuccessResult(),
    ];
  });

  test("successful completion returns result with cost/duration/turns", async () => {
    const result = await runClaude(baseOpts());
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done");
    expect(result.costUsd).toBe(0.5);
    expect(result.durationMs).toBe(2000);
    expect(result.numTurns).toBe(5);
  });

  test("session ID is captured from init message", async () => {
    const result = await runClaude(baseOpts());
    expect(result.sessionId).toBe("sess-abc");
  });

  test("onActivity emits 'status' event on agent init", async () => {
    const events: ActivityEntry[] = [];
    await runClaude({ ...baseOpts(), onActivity: (e) => events.push(e) });
    expect(
      events.some((e) => e.type === "status" && e.summary === "Agent started"),
    ).toBe(true);
  });

  test("onActivity emits 'tool_use' event for assistant tool blocks", async () => {
    const events: ActivityEntry[] = [];
    await runClaude({ ...baseOpts(), onActivity: (e) => events.push(e) });
    expect(
      events.some(
        (e) => e.type === "tool_use" && e.summary.startsWith("Read:"),
      ),
    ).toBe(true);
  });

  test("onActivity emits 'text' event for assistant text blocks", async () => {
    const events: ActivityEntry[] = [];
    await runClaude({ ...baseOpts(), onActivity: (e) => events.push(e) });
    expect(
      events.some(
        (e) => e.type === "text" && e.summary.includes("I read the file."),
      ),
    ).toBe(true);
  });
});

// ─── runClaude — error path ───────────────────────────────────────────────────

describe("runClaude — error path", () => {
  test("SDK error result with errors array joins them with '; '", async () => {
    queryMessages = [
      makeInitMessage(),
      makeErrorResult(["network error", "timeout"]),
    ];
    const result = await runClaude(baseOpts());
    expect(result.error).toBe("network error; timeout");
  });

  test("SDK error result with empty errors array falls back to subtype", async () => {
    queryMessages = [makeInitMessage(), makeErrorResult([], "api_error")];
    const result = await runClaude(baseOpts());
    expect(result.error).toBe("api_error");
  });

  test("exception thrown by query iterator sets result.error", async () => {
    queryError = new Error("iterator exploded");
    const result = await runClaude(baseOpts());
    expect(result.error).toBe("iterator exploded");
  });

  test("onActivity emits error event on SDK error result", async () => {
    queryMessages = [makeInitMessage(), makeErrorResult(["bad output"])];
    const events: ActivityEntry[] = [];
    await runClaude({ ...baseOpts(), onActivity: (e) => events.push(e) });
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ─── runClaude — worktree lifecycle ──────────────────────────────────────────

describe("runClaude — worktree lifecycle", () => {
  beforeEach(() => {
    queryMessages = [makeInitMessage(), makeSuccessResult()];
  });

  test("createWorktree is called when opts.worktree is set", async () => {
    await runClaude({ ...baseOpts(), worktree: "my-worktree" });
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockCreateWorktree.mock.calls[0][1]).toBe("my-worktree");
  });

  test("removeWorktree is called in finally on success", async () => {
    await runClaude({ ...baseOpts(), worktree: "my-worktree" });
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
  });

  test("removeWorktree is called in finally on query error", async () => {
    queryError = new Error("crash");
    await runClaude({ ...baseOpts(), worktree: "my-worktree" });
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
  });

  test("removeWorktree called with keepBranch=true when worktreeBranch is set", async () => {
    await runClaude({
      ...baseOpts(),
      worktree: "my-worktree",
      worktreeBranch: "feature/branch",
    });
    const callArgs = mockRemoveWorktree.mock.calls[0];
    expect(callArgs[2]).toEqual({ keepBranch: true });
  });

  test("createWorktree and removeWorktree not called when opts.worktree is absent", async () => {
    await runClaude(baseOpts());
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});

// ─── runClaude — timeout and abort ───────────────────────────────────────────

describe("runClaude — timeout and abort", () => {
  test("timeout fires: timedOut=true, error='Timed out'", async () => {
    queryBehavior = "abort_throw";
    const result = await runClaude({ ...baseOpts(), timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Timed out");
  });

  test("race: loop completes before timeout → timedOut=false", async () => {
    queryMessages = [makeInitMessage(), makeSuccessResult()];
    const result = await runClaude({ ...baseOpts(), timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("parent signal abort sets error to 'Aborted (shutdown)'", async () => {
    queryBehavior = "abort_throw";
    const parentController = new AbortController();
    const resultPromise = runClaude({
      ...baseOpts(),
      parentSignal: parentController.signal,
    });
    setTimeout(() => parentController.abort(), 20);
    const result = await resultPromise;
    expect(result.error).toBe("Aborted (shutdown)");
  });
});
