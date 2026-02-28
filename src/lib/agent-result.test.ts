import { describe, expect, mock, test } from "bun:test";
import type { AppState } from "../state";
import { handleAgentResult } from "./agent-result";
import type { ClaudeResult } from "./claude";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides?: Partial<ClaudeResult>): ClaudeResult {
  return {
    result: "",
    timedOut: false,
    inactivityTimedOut: false,
    error: undefined,
    costUsd: 0.1,
    durationMs: 1000,
    numTurns: 3,
    ...overrides,
  };
}

function makeState(): {
  state: AppState;
  completeAgent: ReturnType<typeof mock>;
} {
  const completeAgent = mock(() => Promise.resolve());
  const state = { completeAgent } as unknown as AppState;
  return { state, completeAgent };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleAgentResult — inactivity timeout", () => {
  test("returns timed_out status", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({ inactivityTimedOut: true }),
      state,
      "agent-1",
      "Test agent",
    );
    expect(result.status).toBe("timed_out");
  });

  test("returns metrics from ClaudeResult", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({
        inactivityTimedOut: true,
        costUsd: 0.05,
        durationMs: 500,
        numTurns: 2,
      }),
      state,
      "agent-1",
      "Test agent",
    );
    expect(result.metrics).toEqual({
      costUsd: 0.05,
      durationMs: 500,
      numTurns: 2,
    });
  });

  test("calls completeAgent with timed_out status and inactivity error", () => {
    const { state, completeAgent } = makeState();
    handleAgentResult(
      makeResult({
        inactivityTimedOut: true,
        costUsd: 0.1,
        durationMs: 1000,
        numTurns: 3,
      }),
      state,
      "agent-1",
      "Test agent",
    );
    expect(completeAgent).toHaveBeenCalledTimes(1);
    expect(completeAgent).toHaveBeenCalledWith("agent-1", "timed_out", {
      costUsd: 0.1,
      durationMs: 1000,
      numTurns: 3,
      error: "Inactivity timeout",
      exitReason: "inactivity",
    });
  });
});

describe("handleAgentResult — overall timeout", () => {
  test("returns timed_out status", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({ timedOut: true }),
      state,
      "agent-2",
      "Test agent",
    );
    expect(result.status).toBe("timed_out");
  });

  test("returns metrics from ClaudeResult", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({
        timedOut: true,
        costUsd: 0.2,
        durationMs: 1800000,
        numTurns: 10,
      }),
      state,
      "agent-2",
      "Test agent",
    );
    expect(result.metrics).toEqual({
      costUsd: 0.2,
      durationMs: 1800000,
      numTurns: 10,
    });
  });

  test("calls completeAgent with timed_out status and timed-out error", () => {
    const { state, completeAgent } = makeState();
    handleAgentResult(
      makeResult({
        timedOut: true,
        costUsd: 0.2,
        durationMs: 1800000,
        numTurns: 10,
      }),
      state,
      "agent-2",
      "Test agent",
    );
    expect(completeAgent).toHaveBeenCalledTimes(1);
    expect(completeAgent).toHaveBeenCalledWith("agent-2", "timed_out", {
      costUsd: 0.2,
      durationMs: 1800000,
      numTurns: 10,
      error: "Timed out",
      exitReason: "timeout",
    });
  });
});

describe("handleAgentResult — error", () => {
  test("returns failed status", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({ error: "Claude crashed" }),
      state,
      "agent-3",
      "Test agent",
    );
    expect(result.status).toBe("failed");
  });

  test("returns metrics from ClaudeResult", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({
        error: "Claude crashed",
        costUsd: undefined,
        durationMs: 500,
        numTurns: 1,
      }),
      state,
      "agent-3",
      "Test agent",
    );
    expect(result.metrics).toEqual({
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
    });
  });

  test("calls completeAgent with failed status and the error message", () => {
    const { state, completeAgent } = makeState();
    handleAgentResult(
      makeResult({
        error: "Claude crashed",
        costUsd: undefined,
        durationMs: 500,
        numTurns: 1,
      }),
      state,
      "agent-3",
      "Test agent",
    );
    expect(completeAgent).toHaveBeenCalledTimes(1);
    expect(completeAgent).toHaveBeenCalledWith("agent-3", "failed", {
      costUsd: undefined,
      durationMs: 500,
      numTurns: 1,
      error: "Claude crashed",
      exitReason: "error",
    });
  });
});

describe("handleAgentResult — success", () => {
  test("returns completed status", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult(),
      state,
      "agent-4",
      "Test agent",
    );
    expect(result.status).toBe("completed");
  });

  test("returns metrics from ClaudeResult", () => {
    const { state } = makeState();
    const result = handleAgentResult(
      makeResult({ costUsd: 0.5, durationMs: 2000, numTurns: 5 }),
      state,
      "agent-4",
      "Test agent",
    );
    expect(result.metrics).toEqual({
      costUsd: 0.5,
      durationMs: 2000,
      numTurns: 5,
    });
  });

  test("calls completeAgent with completed status and metrics (no error)", () => {
    const { state, completeAgent } = makeState();
    handleAgentResult(
      makeResult({ costUsd: 0.5, durationMs: 2000, numTurns: 5 }),
      state,
      "agent-4",
      "Test agent",
    );
    expect(completeAgent).toHaveBeenCalledTimes(1);
    expect(completeAgent).toHaveBeenCalledWith("agent-4", "completed", {
      costUsd: 0.5,
      durationMs: 2000,
      numTurns: 5,
      exitReason: "success",
    });
  });

  test("inactivityTimedOut takes precedence over timedOut when both true", () => {
    const { state, completeAgent } = makeState();
    const result = handleAgentResult(
      makeResult({ inactivityTimedOut: true, timedOut: true }),
      state,
      "agent-5",
      "Test agent",
    );
    expect(result.status).toBe("timed_out");
    expect(completeAgent).toHaveBeenCalledWith(
      "agent-5",
      "timed_out",
      expect.objectContaining({ error: "Inactivity timeout" }),
    );
  });
});
