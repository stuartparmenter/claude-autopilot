import { describe, expect, test } from "bun:test";
import { isTransientError, withRetry } from "./retry";

const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

describe("isTransientError", () => {
  test("HTTP 429 is transient", () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    expect(isTransientError(err)).toBe(true);
  });

  test("HTTP 500 is transient", () => {
    const err = Object.assign(new Error("internal server error"), {
      status: 500,
    });
    expect(isTransientError(err)).toBe(true);
  });

  test("HTTP 503 is transient", () => {
    const err = Object.assign(new Error("service unavailable"), {
      status: 503,
    });
    expect(isTransientError(err)).toBe(true);
  });

  test("HTTP 404 is not transient", () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    expect(isTransientError(err)).toBe(false);
  });

  test("HTTP 401 is not transient", () => {
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    expect(isTransientError(err)).toBe(false);
  });

  test("HTTP 403 is not transient", () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    expect(isTransientError(err)).toBe(false);
  });

  test("ECONNRESET is transient", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    expect(isTransientError(err)).toBe(true);
  });

  test("ETIMEDOUT is transient", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(isTransientError(err)).toBe(true);
  });

  test("fetch failed message is transient", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  test("non-Error values are not transient", () => {
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  test("succeeds on first try and returns value", async () => {
    const result = await withRetry(async () => 42, "test");
    expect(result).toBe(42);
  });

  test("function that fails twice then succeeds returns success value after 3 calls", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("server error"), { status: 503 });
        }
        return "ok";
      },
      "test",
      noDelay,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("non-transient error (404) is thrown immediately without retry", async () => {
    let calls = 0;
    const err = Object.assign(new Error("not found"), { status: 404 });
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        noDelay,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect(calls).toBe(1);
  });

  test("all attempts exhausted rethrows last error", async () => {
    let calls = 0;
    const err = Object.assign(new Error("server error"), { status: 500 });
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        { maxAttempts: 3, ...noDelay },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect(calls).toBe(3);
  });

  test("maxAttempts: 1 throws on first failure without retry", async () => {
    let calls = 0;
    const err = Object.assign(new Error("server error"), { status: 500 });
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        { maxAttempts: 1, ...noDelay },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect(calls).toBe(1);
  });

  test("custom shouldRetry overrides isTransientError", async () => {
    let calls = 0;
    // Use a custom shouldRetry that rejects 500 (normally transient)
    const err = Object.assign(new Error("server error"), { status: 500 });
    let thrown: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        { shouldRetry: () => false, ...noDelay },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect(calls).toBe(1);
  });

  test("respects Retry-After header on 429 for delay timing", async () => {
    let calls = 0;
    const start = Date.now();
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      response: { headers: { "retry-after": "0" } },
    });
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw err;
        return "done";
      },
      "test",
      { baseDelayMs: 5000 }, // would be slow without Retry-After
    );
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    // Retry-After: 0 means 0ms delay, so elapsed should be well under baseDelayMs
    expect(elapsed).toBeLessThan(1000);
  });
});
