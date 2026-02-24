import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { error, fatal, info, ok, warn } from "./logger";

describe("logger", () => {
  let consoleLogSpy: ReturnType<typeof mock>;
  let consoleErrorSpy: ReturnType<typeof mock>;
  let processExitSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    consoleLogSpy = mock(() => {});
    consoleErrorSpy = mock(() => {});
    processExitSpy = mock(() => {});
    console.log = consoleLogSpy;
    console.error = consoleErrorSpy;
    process.exit = processExitSpy as never;
  });

  afterEach(() => {
    mock.restore();
  });

  test("info() writes to console.log", () => {
    info("hello info");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain("[INFO]");
    expect(consoleLogSpy.mock.calls[0][0]).toContain("hello info");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("ok() writes to console.log", () => {
    ok("hello ok");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain("[OK]");
    expect(consoleLogSpy.mock.calls[0][0]).toContain("hello ok");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("warn() writes to console.log", () => {
    warn("hello warn");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain("[WARN]");
    expect(consoleLogSpy.mock.calls[0][0]).toContain("hello warn");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("error() writes to console.error and returns void (no process.exit)", () => {
    const result = error("hello error");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("[ERROR]");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("hello error");
    expect(processExitSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  test("fatal() writes to console.error and calls process.exit(1)", () => {
    fatal("hello fatal");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("[FATAL]");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("hello fatal");
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
