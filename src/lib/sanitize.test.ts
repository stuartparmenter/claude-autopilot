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
});
