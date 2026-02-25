import { describe, expect, test } from "bun:test";
import {
  AuthenticationLinearError,
  FeatureNotAccessibleLinearError,
  ForbiddenLinearError,
  InvalidInputLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";
import { interruptibleSleep, isFatalError } from "./errors";

describe("isFatalError", () => {
  test("AuthenticationLinearError is fatal", () => {
    expect(
      isFatalError(new AuthenticationLinearError({ message: "auth failed" })),
    ).toBe(true);
  });

  test("ForbiddenLinearError is fatal", () => {
    expect(
      isFatalError(new ForbiddenLinearError({ message: "forbidden" })),
    ).toBe(true);
  });

  test("InvalidInputLinearError is fatal", () => {
    expect(
      isFatalError(new InvalidInputLinearError({ message: "invalid input" })),
    ).toBe(true);
  });

  test("FeatureNotAccessibleLinearError is fatal", () => {
    expect(
      isFatalError(
        new FeatureNotAccessibleLinearError({ message: "not accessible" }),
      ),
    ).toBe(true);
  });

  test("error with 'not found in Linear' message is fatal", () => {
    expect(isFatalError(new Error("Team not found in Linear"))).toBe(true);
  });

  test("error with 'not found for team' message is fatal", () => {
    expect(isFatalError(new Error("Project not found for team"))).toBe(true);
  });

  test("error with 'Config file not found' message is fatal", () => {
    expect(
      isFatalError(new Error("Config file not found at /path/to/config")),
    ).toBe(true);
  });

  test("generic Error is not fatal", () => {
    expect(isFatalError(new Error("something went wrong"))).toBe(false);
  });

  test("RatelimitedLinearError is not fatal (transient)", () => {
    expect(
      isFatalError(new RatelimitedLinearError({ message: "rate limited" })),
    ).toBe(false);
  });

  test("non-Error string with fatal pattern is fatal", () => {
    expect(isFatalError("not found in Linear")).toBe(true);
  });

  test("null is not fatal", () => {
    expect(isFatalError(null)).toBe(false);
  });

  test("partial match 'not found' without full pattern is not fatal", () => {
    expect(isFatalError(new Error("resource not found"))).toBe(false);
  });
});

describe("interruptibleSleep", () => {
  test("pre-aborted signal resolves immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await interruptibleSleep(5000, controller.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("abort during sleep resolves early", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleepPromise = interruptibleSleep(5000, controller.signal);
    // Abort after a short delay
    setTimeout(() => controller.abort(), 20);
    await sleepPromise;
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("full duration sleep when not aborted", async () => {
    const controller = new AbortController();
    const start = Date.now();
    await interruptibleSleep(50, controller.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
