import { describe, expect, test } from "bun:test";
import { sanitizeMessage } from "./sanitize";

describe("sanitizeMessage", () => {
  test("redacts Bearer token", () => {
    expect(sanitizeMessage("Bearer sk-ant-secret123")).toBe(
      "Bearer [REDACTED]",
    );
  });

  test("redacts lin_api_ token", () => {
    expect(sanitizeMessage("key is lin_api_abc123")).toBe(
      "key is lin_api_[REDACTED]",
    );
  });

  test("redacts sk-ant- token", () => {
    expect(sanitizeMessage("token sk-ant-api03-secret")).toBe(
      "token sk-ant-[REDACTED]",
    );
  });

  test("redacts ghp_ GitHub token", () => {
    expect(sanitizeMessage("token ghp_1234567890")).toBe(
      "token ghp_[REDACTED]",
    );
  });

  test("redacts gho_ GitHub token", () => {
    expect(sanitizeMessage("oauth gho_abcdefgh")).toBe("oauth gho_[REDACTED]");
  });

  test("redacts ghs_ GitHub server token", () => {
    expect(sanitizeMessage("server ghs_xyz789")).toBe("server ghs_[REDACTED]");
  });

  test("redacts ghu_ GitHub user token", () => {
    expect(sanitizeMessage("user ghu_tokenhere")).toBe("user ghu_[REDACTED]");
  });

  test("redacts github_pat_ fine-grained token", () => {
    expect(sanitizeMessage("pat github_pat_11ABCDEF_longtoken")).toBe(
      "pat github_pat_[REDACTED]",
    );
  });

  test("redacts multiple tokens in one string", () => {
    expect(
      sanitizeMessage("Bearer sk-ant-secret and lin_api_key123 and ghp_tok"),
    ).toBe("Bearer [REDACTED] and lin_api_[REDACTED] and ghp_[REDACTED]");
  });

  test("leaves clean strings unchanged", () => {
    const msg = "Agent completed successfully with no errors";
    expect(sanitizeMessage(msg)).toBe(msg);
  });

  test("handles empty string", () => {
    expect(sanitizeMessage("")).toBe("");
  });

  test("redacts Bearer token with surrounding context", () => {
    expect(sanitizeMessage("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  // New patterns

  test("redacts AWS access key ID", () => {
    expect(sanitizeMessage("key AKIAIOSFODNN7EXAMPLE used")).toBe(
      "key AKIA[REDACTED] used",
    );
  });

  test("redacts password= assignment", () => {
    expect(sanitizeMessage("password=supersecret123")).toBe(
      "password=[REDACTED]",
    );
  });

  test("redacts secret= assignment", () => {
    expect(sanitizeMessage("secret=mysecretvalue")).toBe("secret=[REDACTED]");
  });

  test("redacts api_key= assignment", () => {
    expect(sanitizeMessage("api_key=abcdef1234567890")).toBe(
      "api_key=[REDACTED]",
    );
  });

  test("redacts token= assignment", () => {
    expect(sanitizeMessage("token=myauthtoken")).toBe("token=[REDACTED]");
  });

  test("redacts assignment patterns case-insensitively", () => {
    expect(sanitizeMessage("TOKEN=abc123 PASSWORD=xyz789")).toBe(
      "TOKEN=[REDACTED] PASSWORD=[REDACTED]",
    );
  });

  test("redacts Slack webhook URL", () => {
    expect(
      sanitizeMessage(
        "webhook https://hooks.slack.com/services/T000/B000/secretXYZ",
      ),
    ).toBe("webhook https://hooks.slack.com/services/[REDACTED]");
  });

  test("redacts npm token", () => {
    expect(sanitizeMessage("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe(
      "npm_[REDACTED]",
    );
  });

  test("does not redact npm_ prefix with wrong length", () => {
    // Only exactly 36 alphanumeric chars after npm_ should match
    const short = "npm_ABC123";
    expect(sanitizeMessage(short)).toBe(short);
  });

  test("redacts Stripe sk_live_ key", () => {
    expect(sanitizeMessage("key sk_live_abcdefghijk1234567890")).toBe(
      "key sk_live_[REDACTED]",
    );
  });

  test("redacts Stripe sk_test_ key", () => {
    expect(sanitizeMessage("key sk_test_abcdefghijk1234567890")).toBe(
      "key sk_test_[REDACTED]",
    );
  });

  test("redacts Stripe pk_live_ key", () => {
    expect(sanitizeMessage("key pk_live_abcdefghijk1234567890")).toBe(
      "key pk_live_[REDACTED]",
    );
  });

  test("redacts Stripe pk_test_ key", () => {
    expect(sanitizeMessage("key pk_test_abcdefghijk1234567890")).toBe(
      "key pk_test_[REDACTED]",
    );
  });

  test("redacts Stripe rk_live_ key", () => {
    expect(sanitizeMessage("key rk_live_abcdefghijk1234567890")).toBe(
      "key rk_live_[REDACTED]",
    );
  });

  test("redacts Stripe rk_test_ key", () => {
    expect(sanitizeMessage("key rk_test_abcdefghijk1234567890")).toBe(
      "key rk_test_[REDACTED]",
    );
  });

  test("redacted transcript string remains valid JSON", () => {
    const messages = [
      {
        role: "tool_result",
        content:
          "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE password=topsecret123 sk_live_xxxxxxxxxxxxxxxxxxx",
      },
      {
        role: "assistant",
        content: "Found credentials in .env file",
      },
    ];
    const json = JSON.stringify(messages);
    const scrubbed = sanitizeMessage(json);
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    const parsed = JSON.parse(scrubbed) as typeof messages;
    expect(JSON.stringify(parsed)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(parsed)).not.toContain("topsecret123");
    expect(JSON.stringify(parsed)).not.toContain("xxxxxxxxxxxxxxxxxxx");
  });

  test("JSON string values with secrets are redacted without corrupting JSON structure", () => {
    const json = JSON.stringify({
      error: "Bearer tok_abc123",
      meta: { token: "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" },
    });
    const scrubbed = sanitizeMessage(json);
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    expect(scrubbed).not.toContain("tok_abc123");
    expect(scrubbed).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
  });
});
