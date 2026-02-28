import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Linear webhook signature.
 * Linear signs the raw request body with HMAC-SHA256 and sends the hex digest
 * in the `x-linear-signature` header.
 */
export function verifyLinearSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf-8")
    .digest("hex");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected))
    return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Verify a GitHub webhook signature.
 * GitHub signs the raw request body with HMAC-SHA256 and sends
 * `sha256=<hex>` in the `x-hub-signature-256` header.
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  if (!secret || !signature) return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected))
    return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export type LinearEventType = "issue_ready" | "unknown";
export type GitHubEventType = "ci_failure" | "pr_merged" | "unknown";

/**
 * Parse a Linear webhook payload and return a normalized event type.
 * Returns "issue_ready" when an issue is moved into the configured ready state.
 */
export function parseLinearEventType(
  headers: { event?: string },
  body: unknown,
  readyStateName: string,
): LinearEventType {
  if (headers.event !== "Issue") return "unknown";
  if (typeof body !== "object" || body === null) return "unknown";
  const payload = body as Record<string, unknown>;
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return "unknown";
  const state = data.state as Record<string, unknown> | undefined;
  if (state?.name === readyStateName) return "issue_ready";
  return "unknown";
}

/**
 * Parse a GitHub webhook payload and return a normalized event type.
 * Returns "ci_failure" when a check_suite completes with failure.
 * Returns "pr_merged" when a pull_request is closed and merged.
 */
export function parseGitHubEventType(
  headers: { event?: string },
  body: unknown,
): GitHubEventType {
  if (typeof body !== "object" || body === null) return "unknown";
  const payload = body as Record<string, unknown>;

  if (headers.event === "check_suite" && payload.action === "completed") {
    const suite = payload.check_suite as Record<string, unknown> | undefined;
    if (suite?.conclusion === "failure") return "ci_failure";
  }

  if (headers.event === "pull_request" && payload.action === "closed") {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (pr?.merged === true) return "pr_merged";
  }

  return "unknown";
}

/**
 * A simple one-shot trigger for waking up the main polling loop when a
 * webhook event arrives. The main loop calls `wait()` and the webhook handler
 * calls `fire()` to interrupt the poll sleep.
 */
export class WebhookTrigger {
  private pending: Array<() => void> = [];

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  fire(): void {
    const listeners = this.pending.splice(0);
    for (const fn of listeners) fn();
  }
}
