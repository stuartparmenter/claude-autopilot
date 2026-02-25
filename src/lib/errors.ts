import {
  AuthenticationLinearError,
  FeatureNotAccessibleLinearError,
  ForbiddenLinearError,
  InvalidInputLinearError,
} from "@linear/sdk";

/** Classify an error as fatal (non-retryable) vs transient. */
export function isFatalError(e: unknown): boolean {
  if (
    e instanceof AuthenticationLinearError ||
    e instanceof ForbiddenLinearError ||
    e instanceof InvalidInputLinearError ||
    e instanceof FeatureNotAccessibleLinearError
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("not found in Linear") ||
    msg.includes("not found for team") ||
    msg.includes("Config file not found")
  );
}

/** Sleep that resolves immediately when the abort signal fires. */
export function interruptibleSleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
