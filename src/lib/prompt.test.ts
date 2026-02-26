import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAuditorPrompt,
  buildPrompt,
  loadPrompt,
  renderPrompt,
} from "./prompt";

describe("renderPrompt", () => {
  test("substitutes a single variable", () => {
    expect(renderPrompt("Hello {{NAME}}", { NAME: "World" })).toBe(
      "Hello World",
    );
  });

  test("substitutes multiple variables", () => {
    expect(renderPrompt("{{A}} + {{B}}", { A: "foo", B: "bar" })).toBe(
      "foo + bar",
    );
  });

  test("substitutes repeated occurrences of a variable", () => {
    expect(renderPrompt("{{X}} and {{X}}", { X: "hi" })).toBe("hi and hi");
  });

  test("unmatched placeholders are left untouched", () => {
    expect(renderPrompt("{{MISSING}} text", {})).toBe("{{MISSING}} text");
  });

  test("empty vars returns template unchanged", () => {
    const template = "no placeholders here";
    expect(renderPrompt(template, {})).toBe(template);
  });

  test("empty template returns empty string", () => {
    expect(renderPrompt("", { FOO: "bar" })).toBe("");
  });

  test("special regex characters in values are treated literally", () => {
    expect(renderPrompt("Cost: {{AMOUNT}}", { AMOUNT: "$1.00" })).toBe(
      "Cost: $1.00",
    );
  });

  test("multiline templates are handled correctly", () => {
    const template = "Line 1: {{A}}\nLine 2: {{B}}";
    expect(renderPrompt(template, { A: "hello", B: "world" })).toBe(
      "Line 1: hello\nLine 2: world",
    );
  });

  test("collapses newlines in substituted values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "foo\n## EVIL\nbar" })).toBe(
      "foo ## EVIL bar",
    );
  });

  test("collapses CRLF newlines", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "foo\r\nbar" })).toBe("foo bar");
  });

  test("strips leading heading markers from values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "## Heading value" })).toBe(
      "Heading value",
    );
  });

  test("does not alter legitimate values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "My Project (v2)" })).toBe(
      "My Project (v2)",
    );
    expect(renderPrompt("{{KEY}}", { KEY: "In Review" })).toBe("In Review");
    expect(renderPrompt("{{KEY}}", { KEY: "ENG" })).toBe("ENG");
  });

  test("mid-string heading markers are preserved (not at start of string)", () => {
    // After newline collapsing, mid-string ## is harmless
    const result = renderPrompt("{{KEY}}", { KEY: "foo\n## EVIL\nbar" });
    expect(result).toBe("foo ## EVIL bar");
    expect(result).not.toContain("\n");
  });
});

describe("loadPrompt", () => {
  test("loads the executor prompt and it is non-empty", () => {
    const prompt = loadPrompt("executor");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("executor prompt contains {{ISSUE_ID}} placeholder", () => {
    const prompt = loadPrompt("executor");
    expect(prompt).toContain("{{ISSUE_ID}}");
  });

  test("loads the auditor prompt and it is non-empty", () => {
    const prompt = loadPrompt("auditor");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("throws for a nonexistent prompt name", () => {
    expect(() => loadPrompt("nonexistent-prompt-xyz")).toThrow();
  });
});

describe("buildPrompt", () => {
  test("loads and renders a prompt in one step", () => {
    const result = buildPrompt("executor", {
      ISSUE_ID: "ENG-99",
      PROJECT: "test",
    });
    expect(result).toContain("ENG-99");
    expect(result).not.toContain("{{ISSUE_ID}}");
  });
});

describe("loadPrompt project-local overrides", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join("/tmp/claude-1002", `prompt-override-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".claude-autopilot", "prompts"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("falls back to bundled prompt when no project-local file exists", () => {
    const bundled = loadPrompt("executor");
    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe(bundled);
  });

  test("uses project-local file when it exists (full override)", () => {
    const overridePath = join(
      tmpDir,
      ".claude-autopilot",
      "prompts",
      "executor.md",
    );
    writeFileSync(overridePath, "# Custom executor prompt");

    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe("# Custom executor prompt");
  });

  test("substitutes {{BASE_PROMPT}} with bundled content (partial override)", () => {
    const bundled = loadPrompt("executor");
    const overridePath = join(
      tmpDir,
      ".claude-autopilot",
      "prompts",
      "executor.md",
    );
    writeFileSync(
      overridePath,
      "{{BASE_PROMPT}}\n\n## Project Rules\n- Always use pytest",
    );

    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe(`${bundled}\n\n## Project Rules\n- Always use pytest`);
    expect(result).toContain("{{ISSUE_ID}}"); // bundled content preserved
    expect(result).toContain("Always use pytest"); // project rules appended
  });

  test("partial override preserves all bundled prompt occurrences of {{BASE_PROMPT}}", () => {
    const bundled = loadPrompt("executor");
    const overridePath = join(
      tmpDir,
      ".claude-autopilot",
      "prompts",
      "executor.md",
    );
    writeFileSync(
      overridePath,
      "Before\n{{BASE_PROMPT}}\nMiddle\n{{BASE_PROMPT}}\nAfter",
    );

    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe(`Before\n${bundled}\nMiddle\n${bundled}\nAfter`);
  });

  test("buildPrompt uses project-local override when projectPath provided", () => {
    const overridePath = join(
      tmpDir,
      ".claude-autopilot",
      "prompts",
      "executor.md",
    );
    writeFileSync(overridePath, "Custom: {{ISSUE_ID}}");

    const result = buildPrompt("executor", { ISSUE_ID: "ENG-42" }, tmpDir);
    expect(result).toBe("Custom: ENG-42");
  });

  test("loadPrompt without projectPath returns bundled prompt regardless of override files", () => {
    const overridePath = join(
      tmpDir,
      ".claude-autopilot",
      "prompts",
      "executor.md",
    );
    writeFileSync(overridePath, "Should not be used");

    const bundled = loadPrompt("executor");
    // No projectPath → bundled is used
    expect(bundled).not.toBe("Should not be used");
    expect(bundled.length).toBeGreaterThan(0);
  });
});

describe("buildAuditorPrompt", () => {
  test("returns a non-empty string", () => {
    const result = buildAuditorPrompt({});
    expect(result.length).toBeGreaterThan(0);
  });

  test("contains planner subagent section", () => {
    const result = buildAuditorPrompt({});
    expect(result).toContain("## Planner Subagent Prompt");
  });

  test("contains verifier subagent section", () => {
    const result = buildAuditorPrompt({});
    expect(result).toContain("## Verifier Subagent Prompt");
  });

  test("contains security reviewer subagent section", () => {
    const result = buildAuditorPrompt({});
    expect(result).toContain("## Security Reviewer Subagent Prompt");
  });

  test("contains the reference header for subagent prompts", () => {
    const result = buildAuditorPrompt({});
    expect(result).toContain("# Reference: Subagent Prompts");
  });

  test("contains product manager subagent section", () => {
    const result = buildAuditorPrompt({});
    expect(result).toContain("## Product Manager Subagent Prompt");
  });

  test("substitutes brainstorm variables", () => {
    const result = buildAuditorPrompt({
      BRAINSTORM_FEATURES: "true",
      BRAINSTORM_DIMENSIONS: "user-facing-features, developer-experience",
      MAX_IDEAS_PER_RUN: "5",
      FEATURE_TARGET_STATE: "Triage",
    });
    expect(result).toContain("Triage");
    expect(result).not.toContain("{{FEATURE_TARGET_STATE}}");
    expect(result).not.toContain("{{MAX_IDEAS_PER_RUN}}");
    expect(result).not.toContain("{{BRAINSTORM_FEATURES}}");
    expect(result).toContain("Phase 1.5: Brainstorm Features");
    expect(result).toContain("auto-feature-idea");
  });
});
