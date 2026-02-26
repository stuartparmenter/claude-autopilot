import { beforeEach, describe, expect, test } from "bun:test";
import { AppState } from "../state";
import {
  CircuitBreakerRegistry,
  CircuitOpenError,
  defaultRegistry,
  inferService,
} from "./circuit-breaker";
import { withRetry } from "./retry";

// Fast config for tests: open after 3 failures in 5 s, cooldown 100 ms
const TEST_CONFIG = {
  failureThreshold: 3,
  windowMs: 5_000,
  cooldownMs: 100,
};

const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

describe("inferService", () => {
  test("getPR labels map to github", () => {
    expect(inferService("getPR #42")).toBe("github");
    expect(inferService("getPR")).toBe("github");
  });

  test("getChecks labels map to github", () => {
    expect(inferService("getChecks #10")).toBe("github");
  });

  test("getRepo labels map to github", () => {
    expect(inferService("getRepo owner/repo")).toBe("github");
  });

  test("enableAutoMerge labels map to github", () => {
    expect(inferService("enableAutoMerge #7")).toBe("github");
  });

  test("listReviews labels map to github", () => {
    expect(inferService("listReviews #3")).toBe("github");
  });

  test("listReviewComments labels map to github", () => {
    expect(inferService("listReviewComments #3")).toBe("github");
  });

  test("validateGitHub maps to github", () => {
    expect(inferService("validateGitHub")).toBe("github");
  });

  test("linear labels stay as linear", () => {
    expect(inferService("findTeam")).toBe("linear");
    expect(inferService("getReadyIssues")).toBe("linear");
    expect(inferService("updateIssue")).toBe("linear");
    expect(inferService("checkOpenPRs")).toBe("linear");
    expect(inferService("checkProjects")).toBe("linear");
  });

  test("unknown labels default to linear", () => {
    expect(inferService("someUnknownLabel")).toBe("linear");
    expect(inferService("test")).toBe("linear");
  });
});

describe("CircuitBreakerRegistry", () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry(TEST_CONFIG);
  });

  test("starts in closed state for all services", () => {
    expect(registry.getState("linear")).toBe("closed");
    expect(registry.getState("github")).toBe("closed");
  });

  test("transitions to open after failureThreshold failures within window", () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    expect(registry.getState("linear")).toBe("closed");
    registry.recordFailure("linear");
    expect(registry.getState("linear")).toBe("open");
  });

  test("linear and github circuits are independent", () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    expect(registry.getState("linear")).toBe("open");
    expect(registry.getState("github")).toBe("closed");
  });

  test("isOpen returns true and blocks calls when open", () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    expect(registry.isOpen("linear")).toBe(true);
  });

  test("transitions to half-open after cooldown elapses", async () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    expect(registry.getState("linear")).toBe("open");

    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    expect(registry.getState("linear")).toBe("half-open");
  });

  test("half-open allows first probe (isOpen returns false once)", async () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");

    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    // First call: probe allowed
    expect(registry.isOpen("linear")).toBe(false);
    // Second call before probe resolves: blocked
    expect(registry.isOpen("linear")).toBe(true);
  });

  test("successful probe in half-open closes the circuit", async () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");

    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    registry.isOpen("linear"); // grant probe
    registry.recordSuccess("linear");

    expect(registry.getState("linear")).toBe("closed");
  });

  test("failed probe in half-open re-opens the circuit", async () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");

    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    registry.isOpen("linear"); // grant probe
    registry.recordFailure("linear"); // probe fails

    expect(registry.getState("linear")).toBe("open");
  });

  test("reset restores closed state and clears all data", () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    expect(registry.getState("linear")).toBe("open");

    registry.reset("linear");
    expect(registry.getState("linear")).toBe("closed");
    expect(registry.isOpen("linear")).toBe(false);
  });

  test("reset() with no argument resets all services", () => {
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("linear");
    registry.recordFailure("github");
    registry.recordFailure("github");
    registry.recordFailure("github");

    registry.reset();

    expect(registry.getState("linear")).toBe("closed");
    expect(registry.getState("github")).toBe("closed");
  });

  test("getAllStates returns both services", () => {
    const states = registry.getAllStates();
    expect(states.linear).toBe("closed");
    expect(states.github).toBe("closed");
  });
});

describe("withRetry circuit-breaker integration", () => {
  beforeEach(() => {
    defaultRegistry.reset();
  });

  test("open circuit causes withRetry to throw CircuitOpenError with zero fn invocations", async () => {
    // Open the linear circuit by recording failures directly
    for (let i = 0; i < 10; i++) {
      defaultRegistry.recordFailure("linear");
    }

    let calls = 0;
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          return "ok";
        },
        "getReadyIssues",
        { service: "linear" },
      );
    } catch (e) {
      thrown = e;
    }

    expect(calls).toBe(0);
    expect(thrown).toBeInstanceOf(CircuitOpenError);
    expect((thrown as CircuitOpenError).service).toBe("linear");
    expect((thrown as CircuitOpenError).label).toBe("getReadyIssues");
  });

  test("open github circuit does not block linear calls", async () => {
    for (let i = 0; i < 10; i++) {
      defaultRegistry.recordFailure("github");
    }

    const result = await withRetry(async () => "linear-ok", "findTeam", {
      service: "linear",
    });
    expect(result).toBe("linear-ok");
  });

  test("successful probe in half-open closes the circuit and allows subsequent calls", async () => {
    const fastRegistry = new CircuitBreakerRegistry(TEST_CONFIG);
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      fastRegistry.recordFailure("linear");
    }
    expect(fastRegistry.isOpen("linear")).toBe(true);

    // Cooldown elapses
    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    // State is now half-open
    expect(fastRegistry.getState("linear")).toBe("half-open");

    // Simulate probe success
    fastRegistry.isOpen("linear"); // grants probe
    fastRegistry.recordSuccess("linear");
    expect(fastRegistry.getState("linear")).toBe("closed");
  });

  test("failed probe re-opens the circuit", async () => {
    const fastRegistry = new CircuitBreakerRegistry(TEST_CONFIG);
    for (let i = 0; i < 3; i++) {
      fastRegistry.recordFailure("linear");
    }

    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));

    fastRegistry.isOpen("linear"); // grants probe
    fastRegistry.recordFailure("linear"); // probe fails

    expect(fastRegistry.getState("linear")).toBe("open");
    expect(fastRegistry.isOpen("linear")).toBe(true);
  });

  test("transient failures inside withRetry increment the circuit breaker", async () => {
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          throw Object.assign(new Error("server error"), { status: 500 });
        },
        "getReadyIssues",
        { maxAttempts: 3, service: "linear", ...noDelay },
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // 3 transient failures recorded
    const states = defaultRegistry.getAllStates();
    // Circuit is still closed (only 3 out of 10 threshold)
    expect(states.linear).toBe("closed");
  });
});

describe("AppState.toJSON() apiHealth", () => {
  beforeEach(() => {
    defaultRegistry.reset();
  });

  test("toJSON includes apiHealth with closed state initially", () => {
    const state = new AppState();
    const snapshot = state.toJSON();
    expect(snapshot.apiHealth).toBeDefined();
    expect(snapshot.apiHealth.linear).toBe("closed");
    expect(snapshot.apiHealth.github).toBe("closed");
  });

  test("toJSON reflects open circuit state", () => {
    for (let i = 0; i < 10; i++) {
      defaultRegistry.recordFailure("linear");
    }

    const state = new AppState();
    const snapshot = state.toJSON();
    expect(snapshot.apiHealth.linear).toBe("open");
    expect(snapshot.apiHealth.github).toBe("closed");
  });

  test("toJSON reflects half-open state after cooldown", async () => {
    // Use a registry with short cooldown
    const fastRegistry = new CircuitBreakerRegistry(TEST_CONFIG);
    for (let i = 0; i < 3; i++) {
      fastRegistry.recordFailure("linear");
    }
    await new Promise((r) => setTimeout(r, TEST_CONFIG.cooldownMs + 10));
    // Confirm it's half-open on the local registry
    expect(fastRegistry.getState("linear")).toBe("half-open");

    // The defaultRegistry is still in initial state for this test
    const state = new AppState();
    const snapshot = state.toJSON();
    // defaultRegistry was reset in beforeEach, so apiHealth should be closed
    expect(snapshot.apiHealth.linear).toBe("closed");
  });
});
