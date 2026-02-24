import {
  AuthenticationLinearError,
  FeatureNotAccessibleLinearError,
  ForbiddenLinearError,
  InvalidInputLinearError,
  LinearError,
  NetworkLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";
import { warn } from "./logger";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

interface RetryOptions {
  label?: string;
  maxRetries?: number;
}

function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof InvalidInputLinearError ||
    error instanceof AuthenticationLinearError ||
    error instanceof ForbiddenLinearError ||
    error instanceof FeatureNotAccessibleLinearError
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RatelimitedLinearError) return true;
  if (error instanceof NetworkLinearError) return true;
  if (error instanceof TypeError) return true; // fetch failures
  if (
    error instanceof LinearError &&
    error.status !== undefined &&
    error.status >= 500
  )
    return true;
  return false;
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (
    error instanceof RatelimitedLinearError &&
    error.retryAfter !== undefined
  ) {
    return Math.min(error.retryAfter * 1_000, MAX_DELAY_MS);
  }
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

/**
 * Wraps an async function with exponential backoff retry logic for Linear API calls.
 *
 * Retries on: RatelimitedLinearError (using retryAfter), NetworkLinearError,
 * TypeError (fetch failures), and 5xx LinearErrors.
 *
 * Immediately rethrows: InvalidInputLinearError, AuthenticationLinearError,
 * ForbiddenLinearError, FeatureNotAccessibleLinearError.
 *
 * Defaults: base 1s, cap 30s, max 3 retries (4 total attempts).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { label = "Linear API", maxRetries = DEFAULT_MAX_RETRIES } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isNonRetryable(error) || !isRetryable(error)) {
        throw error;
      }

      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      const delayMs = retryDelayMs(error, attempt);
      const msg = error instanceof Error ? error.message : String(error);
      warn(
        `${label}: attempt ${attempt + 1}/${maxRetries + 1} failed (${msg}), retrying in ${Math.round(delayMs)}ms`,
      );

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
