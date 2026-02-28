import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  parseGitHubEventType,
  parseLinearEventType,
  verifyGitHubSignature,
  verifyLinearSignature,
  WebhookTrigger,
} from "./webhooks";

// ---------------------------------------------------------------------------
// verifyLinearSignature
// ---------------------------------------------------------------------------

describe("verifyLinearSignature", () => {
  const secret = "test-linear-secret";
  const body = JSON.stringify({ type: "Issue", action: "update" });

  function sign(s: string, b: string): string {
    return createHmac("sha256", s).update(b, "utf-8").digest("hex");
  }

  test("returns true for a valid signature", () => {
    const sig = sign(secret, body);
    expect(verifyLinearSignature(secret, body, sig)).toBe(true);
  });

  test("returns false for a tampered body", () => {
    const sig = sign(secret, body);
    expect(verifyLinearSignature(secret, `${body}tampered`, sig)).toBe(false);
  });

  test("returns false for a wrong secret", () => {
    const sig = sign("wrong-secret", body);
    expect(verifyLinearSignature(secret, body, sig)).toBe(false);
  });

  test("returns false when signature is empty", () => {
    expect(verifyLinearSignature(secret, body, "")).toBe(false);
  });

  test("returns false when secret is empty", () => {
    const sig = sign(secret, body);
    expect(verifyLinearSignature("", body, sig)).toBe(false);
  });

  test("returns false for a signature of different length", () => {
    expect(verifyLinearSignature(secret, body, "short")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyGitHubSignature
// ---------------------------------------------------------------------------

describe("verifyGitHubSignature", () => {
  const secret = "test-github-secret";
  const body = JSON.stringify({ action: "completed" });

  function sign(s: string, b: string): string {
    return `sha256=${createHmac("sha256", s).update(b, "utf-8").digest("hex")}`;
  }

  test("returns true for a valid sha256= signature", () => {
    const sig = sign(secret, body);
    expect(verifyGitHubSignature(secret, body, sig)).toBe(true);
  });

  test("returns false for a tampered body", () => {
    const sig = sign(secret, body);
    expect(verifyGitHubSignature(secret, `${body}x`, sig)).toBe(false);
  });

  test("returns false for a wrong secret", () => {
    const sig = sign("other-secret", body);
    expect(verifyGitHubSignature(secret, body, sig)).toBe(false);
  });

  test("returns false when signature lacks sha256= prefix", () => {
    const hex = createHmac("sha256", secret)
      .update(body, "utf-8")
      .digest("hex");
    expect(verifyGitHubSignature(secret, body, hex)).toBe(false);
  });

  test("returns false when signature is empty", () => {
    expect(verifyGitHubSignature(secret, body, "")).toBe(false);
  });

  test("returns false when secret is empty", () => {
    const sig = sign(secret, body);
    expect(verifyGitHubSignature("", body, sig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseLinearEventType
// ---------------------------------------------------------------------------

describe("parseLinearEventType", () => {
  const readyState = "Todo";

  test("returns issue_ready when event is Issue and state matches", () => {
    const body = {
      action: "update",
      data: { state: { name: "Todo" } },
    };
    expect(parseLinearEventType({ event: "Issue" }, body, readyState)).toBe(
      "issue_ready",
    );
  });

  test("returns unknown when event is not Issue", () => {
    const body = { action: "update", data: { state: { name: "Todo" } } };
    expect(parseLinearEventType({ event: "Comment" }, body, readyState)).toBe(
      "unknown",
    );
  });

  test("returns unknown when state name does not match", () => {
    const body = { action: "update", data: { state: { name: "In Progress" } } };
    expect(parseLinearEventType({ event: "Issue" }, body, readyState)).toBe(
      "unknown",
    );
  });

  test("returns unknown when body has no data field", () => {
    const body = { action: "update" };
    expect(parseLinearEventType({ event: "Issue" }, body, readyState)).toBe(
      "unknown",
    );
  });

  test("returns unknown when body is null", () => {
    expect(parseLinearEventType({ event: "Issue" }, null, readyState)).toBe(
      "unknown",
    );
  });

  test("returns unknown when event header is missing", () => {
    const body = { action: "update", data: { state: { name: "Todo" } } };
    expect(parseLinearEventType({}, body, readyState)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// parseGitHubEventType
// ---------------------------------------------------------------------------

describe("parseGitHubEventType", () => {
  test("returns ci_failure for check_suite completed with failure", () => {
    const body = {
      action: "completed",
      check_suite: { conclusion: "failure" },
    };
    expect(parseGitHubEventType({ event: "check_suite" }, body)).toBe(
      "ci_failure",
    );
  });

  test("returns unknown for check_suite completed with success", () => {
    const body = {
      action: "completed",
      check_suite: { conclusion: "success" },
    };
    expect(parseGitHubEventType({ event: "check_suite" }, body)).toBe(
      "unknown",
    );
  });

  test("returns unknown for check_suite with action other than completed", () => {
    const body = {
      action: "requested",
      check_suite: { conclusion: "failure" },
    };
    expect(parseGitHubEventType({ event: "check_suite" }, body)).toBe(
      "unknown",
    );
  });

  test("returns pr_merged for pull_request closed and merged", () => {
    const body = { action: "closed", pull_request: { merged: true } };
    expect(parseGitHubEventType({ event: "pull_request" }, body)).toBe(
      "pr_merged",
    );
  });

  test("returns unknown for pull_request closed but not merged", () => {
    const body = { action: "closed", pull_request: { merged: false } };
    expect(parseGitHubEventType({ event: "pull_request" }, body)).toBe(
      "unknown",
    );
  });

  test("returns unknown for unknown event type", () => {
    const body = { action: "created" };
    expect(parseGitHubEventType({ event: "issue_comment" }, body)).toBe(
      "unknown",
    );
  });

  test("returns unknown when body is null", () => {
    expect(parseGitHubEventType({ event: "check_suite" }, null)).toBe(
      "unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// WebhookTrigger
// ---------------------------------------------------------------------------

describe("WebhookTrigger", () => {
  test("wait() resolves after fire()", async () => {
    const trigger = new WebhookTrigger();
    let resolved = false;
    const p = trigger.wait().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    trigger.fire();
    await p;
    expect(resolved).toBe(true);
  });

  test("fire() resolves all pending waiters", async () => {
    const trigger = new WebhookTrigger();
    const results: number[] = [];
    const p1 = trigger.wait().then(() => results.push(1));
    const p2 = trigger.wait().then(() => results.push(2));
    trigger.fire();
    await Promise.all([p1, p2]);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  test("fire() before wait() does not pre-resolve subsequent waits", async () => {
    const trigger = new WebhookTrigger();
    trigger.fire(); // fires with no listeners
    let resolved = false;
    // This promise should NOT auto-resolve because the earlier fire() had no listeners
    const p = trigger.wait().then(() => {
      resolved = true;
    });
    // Give microtasks a chance to run
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Now fire again to clean up
    trigger.fire();
    await p;
    expect(resolved).toBe(true);
  });

  test("wait() returns a new unresolved promise after fire()", async () => {
    const trigger = new WebhookTrigger();
    const p1 = trigger.wait();
    trigger.fire();
    await p1;
    // Second wait should not be resolved yet
    let resolved = false;
    const p2 = trigger.wait().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    trigger.fire();
    await p2;
    expect(resolved).toBe(true);
  });
});
