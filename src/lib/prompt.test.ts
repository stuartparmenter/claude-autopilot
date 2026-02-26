import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrompt,
  loadPrompt,
  renderPrompt,
  sanitizePromptValue,
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

  test("loads the CTO prompt and it is non-empty", () => {
    const prompt = loadPrompt("cto");
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
    mkdirSync(join(tmpDir, ".autopilot", "prompts"), {
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
    const overridePath = join(tmpDir, ".autopilot", "prompts", "executor.md");
    writeFileSync(overridePath, "# Custom executor prompt");

    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe("# Custom executor prompt");
  });

  test("substitutes {{BASE_PROMPT}} with bundled content (partial override)", () => {
    const bundled = loadPrompt("executor");
    const overridePath = join(tmpDir, ".autopilot", "prompts", "executor.md");
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
    const overridePath = join(tmpDir, ".autopilot", "prompts", "executor.md");
    writeFileSync(
      overridePath,
      "Before\n{{BASE_PROMPT}}\nMiddle\n{{BASE_PROMPT}}\nAfter",
    );

    const result = loadPrompt("executor", tmpDir);
    expect(result).toBe(`Before\n${bundled}\nMiddle\n${bundled}\nAfter`);
  });

  test("buildPrompt uses project-local override when projectPath provided", () => {
    const overridePath = join(tmpDir, ".autopilot", "prompts", "executor.md");
    writeFileSync(overridePath, "Custom: {{ISSUE_ID}}");

    const result = buildPrompt("executor", { ISSUE_ID: "ENG-42" }, tmpDir);
    expect(result).toBe("Custom: ENG-42");
  });

  test("loadPrompt without projectPath returns bundled prompt regardless of override files", () => {
    const overridePath = join(tmpDir, ".autopilot", "prompts", "executor.md");
    writeFileSync(overridePath, "Should not be used");

    const bundled = loadPrompt("executor");
    // No projectPath → bundled is used
    expect(bundled).not.toBe("Should not be used");
    expect(bundled.length).toBeGreaterThan(0);
  });
});

describe("sanitizePromptValue", () => {
  test("collapses newlines to spaces", () => {
    expect(sanitizePromptValue("foo\nbar")).toBe("foo bar");
  });

  test("collapses CRLF to spaces", () => {
    expect(sanitizePromptValue("foo\r\nbar")).toBe("foo bar");
  });

  test("strips leading heading markers", () => {
    expect(sanitizePromptValue("## Heading")).toBe("Heading");
  });

  test("trims whitespace", () => {
    expect(sanitizePromptValue("  value  ")).toBe("value");
  });

  test("does not alter normal values", () => {
    expect(sanitizePromptValue("My Project (v2)")).toBe("My Project (v2)");
  });
});

describe("renderPrompt with rawVars", () => {
  test("rawVars are substituted without sanitization", () => {
    const template = "Header\n{{RAW}}\nFooter";
    const result = renderPrompt(template, {}, { RAW: "line1\nline2\nline3" });
    expect(result).toBe("Header\nline1\nline2\nline3\nFooter");
  });

  test("rawVars preserve multi-line structure", () => {
    const list = "- ENG-1: Issue one\n- ENG-2: Issue two";
    const result = renderPrompt("Queue:\n{{LIST}}", {}, { LIST: list });
    expect(result).toContain("- ENG-1: Issue one\n- ENG-2: Issue two");
  });

  test("vars are sanitized while rawVars are not", () => {
    const result = renderPrompt(
      "{{TITLE}}\n{{LIST}}",
      { TITLE: "## Injected\nfoo" },
      { LIST: "line1\nline2" },
    );
    expect(result).toBe("Injected foo\nline1\nline2");
  });

  test("rawVars default to empty object when omitted", () => {
    expect(renderPrompt("{{A}}", { A: "hello" })).toBe("hello");
  });
});

describe("loadPrompt — project-owner prompt", () => {
  test("loads the project-owner prompt and it is non-empty", () => {
    const prompt = loadPrompt("project-owner");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("project-owner prompt contains expected placeholders", () => {
    const prompt = loadPrompt("project-owner");
    expect(prompt).toContain("{{PROJECT_NAME}}");
    expect(prompt).toContain("{{PROJECT_ID}}");
    expect(prompt).toContain("{{LINEAR_TEAM}}");
    expect(prompt).toContain("{{INITIATIVE_NAME}}");
    expect(prompt).toContain("{{READY_STATE}}");
    expect(prompt).toContain("{{BLOCKED_STATE}}");
    expect(prompt).toContain("{{TRIAGE_STATE}}");
    expect(prompt).toContain("{{TRIAGE_LIST}}");
  });
});

describe("buildPrompt — project-owner prompt", () => {
  test("substitutes all variables", () => {
    const result = buildPrompt(
      "project-owner",
      {
        PROJECT_NAME: "My Project",
        PROJECT_ID: "proj-123",
        LINEAR_TEAM: "ENG",
        INITIATIVE_NAME: "Test Initiative",
        READY_STATE: "Ready",
        BLOCKED_STATE: "Blocked",
        TRIAGE_STATE: "Triage",
      },
      undefined,
      { TRIAGE_LIST: "- ENG-1: Fix bug\n- ENG-2: Add feature" },
    );
    expect(result).toContain("My Project");
    expect(result).toContain("proj-123");
    expect(result).toContain("ENG");
    expect(result).toContain("Test Initiative");
    expect(result).toContain("Ready");
    expect(result).toContain("Blocked");
    expect(result).toContain("Triage");
    expect(result).not.toContain("{{PROJECT_NAME}}");
    expect(result).not.toContain("{{TRIAGE_LIST}}");
  });

  test("TRIAGE_LIST preserves multi-line formatting", () => {
    const list = "- ENG-1: Fix auth\n- ENG-2: Add tests";
    const result = buildPrompt(
      "project-owner",
      {
        PROJECT_NAME: "P",
        PROJECT_ID: "id",
        LINEAR_TEAM: "ENG",
        INITIATIVE_NAME: "I",
        READY_STATE: "R",
        BLOCKED_STATE: "B",
        TRIAGE_STATE: "T",
      },
      undefined,
      { TRIAGE_LIST: list },
    );
    expect(result).toContain("- ENG-1: Fix auth\n- ENG-2: Add tests");
  });
});

describe("buildPrompt — CTO prompt", () => {
  test("returns a non-empty string", () => {
    const result = buildPrompt("cto", {});
    expect(result.length).toBeGreaterThan(0);
  });

  test("substitutes REPO_NAME variable", () => {
    const result = buildPrompt("cto", { REPO_NAME: "my-app" });
    expect(result).toContain("my-app");
    expect(result).not.toContain("{{REPO_NAME}}");
  });

  test("substitutes LINEAR_TEAM variable", () => {
    const result = buildPrompt("cto", { LINEAR_TEAM: "ENG" });
    expect(result).toContain("ENG");
  });

  test("substitutes MAX_ISSUES_PER_RUN variable", () => {
    const result = buildPrompt("cto", { MAX_ISSUES_PER_RUN: "5" });
    expect(result).not.toContain("{{MAX_ISSUES_PER_RUN}}");
  });

  test("contains lifecycle classification rubric", () => {
    const result = buildPrompt("cto", {});
    expect(result).toContain("EARLY");
    expect(result).toContain("GROWTH");
    expect(result).toContain("MATURE");
  });

  test("contains phase structure", () => {
    const result = buildPrompt("cto", {});
    expect(result).toContain("Phase 0");
    expect(result).toContain("Phase 1");
    expect(result).toContain("Phase 2");
    expect(result).toContain("Phase 3");
  });
});

describe("loadPrompt — reviewer prompt", () => {
  test("loads the reviewer prompt and it is non-empty", () => {
    const prompt = loadPrompt("reviewer");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("reviewer prompt contains expected placeholders", () => {
    const prompt = loadPrompt("reviewer");
    expect(prompt).toContain("{{LINEAR_TEAM}}");
    expect(prompt).toContain("{{TRIAGE_STATE}}");
    expect(prompt).toContain("{{MAX_ISSUES}}");
    expect(prompt).toContain("{{RUN_SUMMARIES}}");
    expect(prompt).toContain("{{REPO_NAME}}");
  });
});

describe("buildPrompt — reviewer prompt", () => {
  test("renders without errors and substitutes all variables", () => {
    const result = buildPrompt(
      "reviewer",
      {
        LINEAR_TEAM: "ENG",
        TRIAGE_STATE: "Triage",
        MAX_ISSUES: "5",
        REPO_NAME: "test-repo",
      },
      undefined,
      { RUN_SUMMARIES: "--- Run run-1 ---\nIssue: ENG-1\nStatus: completed" },
    );
    expect(result).toContain("ENG");
    expect(result).toContain("Triage");
    expect(result).toContain("5");
    expect(result).toContain("test-repo");
    expect(result).toContain("run-1");
    expect(result).not.toContain("{{LINEAR_TEAM}}");
    expect(result).not.toContain("{{TRIAGE_STATE}}");
    expect(result).not.toContain("{{MAX_ISSUES}}");
    expect(result).not.toContain("{{REPO_NAME}}");
    expect(result).not.toContain("{{RUN_SUMMARIES}}");
  });

  test("RUN_SUMMARIES preserves multi-line formatting", () => {
    const summaries =
      "--- Run run-1 ---\nIssue: ENG-1\nStatus: completed\n\n--- Run run-2 ---\nIssue: ENG-2\nStatus: failed";
    const result = buildPrompt(
      "reviewer",
      {
        LINEAR_TEAM: "ENG",
        TRIAGE_STATE: "Triage",
        MAX_ISSUES: "5",
        REPO_NAME: "test",
      },
      undefined,
      { RUN_SUMMARIES: summaries },
    );
    expect(result).toContain("--- Run run-1 ---\nIssue: ENG-1");
    expect(result).toContain("--- Run run-2 ---\nIssue: ENG-2");
  });
});
