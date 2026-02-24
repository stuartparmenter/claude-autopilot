import { warn } from "./logger";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Returns true for errors worth retrying:
 * - HTTP 429 (rate limit)
 * - HTTP 5xx (server errors)
 * - Network errors (ECONNRESET, ETIMEDOUT, fetch failed)
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Duck-type check for Octokit's RequestError (.status property)
  const statusErr = err as Error & { status?: unknown };
  if (typeof statusErr.status === "number") {
    return statusErr.status === 429 || statusErr.status >= 500;
  }

  // Network error codes
  const codeErr = err as Error & { code?: unknown };
  if (codeErr.code === "ECONNRESET" || codeErr.code === "ETIMEDOUT") {
    return true;
  }

  // Fetch-level failure messages
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout")
  );
}

/**
 * Extract delay from Retry-After header (Octokit RequestError carries response.headers).
 * Returns milliseconds, or null if not applicable.
 */
function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;

  const reqErr = err as Error & {
    status?: unknown;
    response?: { headers?: Record<string, string | string[] | undefined> };
  };
  if (reqErr.status !== 429) return null;

  const header = reqErr.response?.headers?.["retry-after"];
  if (!header) return null;

  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;

  // Seconds format
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;

  // HTTP-date format
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

/**
 * Retry fn on transient errors with exponential backoff + jitter.
 * @param fn - Async function to call
 * @param label - Identifier for log output (e.g., "getPR #42")
 * @param opts - Override defaults
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const shouldRetry = opts.shouldRetry ?? isTransientError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const fromHeader = retryAfterMs(err);
      const expo = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * 0.3 * expo;
      const delayMs = fromHeader ?? Math.min(expo + jitter, maxDelayMs);

      warn(
        `[${label}] attempt ${attempt}/${maxAttempts} failed — retrying in ${Math.round(delayMs)}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Unreachable: loop always returns or throws before exhausting attempts
  throw new Error("unreachable");
}
