import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOPILOT_ROOT, buildPrompt } from "./lib/prompt";

describe("explain", () => {
  test("explain.ts script file exists", () => {
    expect(existsSync(resolve(import.meta.dir, "explain.ts"))).toBe(true);
  });

  test("prompts/explain.md exists", () => {
    expect(existsSync(resolve(AUTOPILOT_ROOT, "prompts", "explain.md"))).toBe(
      true,
    );
  });

  test("buildPrompt('explain', vars) succeeds with expected template variables", () => {
    const vars = {
      LINEAR_TEAM: "ENG",
      MAX_ISSUES_PER_RUN: "5",
      REPO_NAME: "test-repo",
      INITIATIVE_NAME: "Test Initiative",
      INITIATIVE_ID: "init-123",
      TRIAGE_STATE: "Triage",
      READY_STATE: "Todo",
      TODAY: "2024-01-01",
    };
    const result = buildPrompt("explain", vars);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("{{LINEAR_TEAM}}");
    expect(result).not.toContain("{{REPO_NAME}}");
    expect(result).toContain("ENG");
    expect(result).toContain("test-repo");
  });

  test("explain prompt contains read-only prohibition", () => {
    const result = buildPrompt("explain", {});
    expect(result).toContain("READ-ONLY");
    expect(result).toContain("MUST NOT");
    expect(result).toContain("save_issue");
  });
});
