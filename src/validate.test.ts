import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfig,
  checkEnvVars,
  checkPromptTemplates,
  checkWorktreeDir,
} from "./validate";

let tmpDir: string;

function writeConfig(content: string): string {
  writeFileSync(join(tmpDir, ".claude-autopilot.yml"), content, "utf-8");
  return tmpDir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autopilot-validate-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkConfig", () => {
  test("passes with valid config and returns team name", async () => {
    writeConfig("linear:\n  team: ENG\n");
    const result = await checkConfig(tmpDir);
    expect(result).toContain("ENG");
  });

  test("throws actionable error when config file is missing", async () => {
    await expect(checkConfig(tmpDir)).rejects.toThrow("Config file not found");
  });

  test("throws actionable error for invalid executor.parallel value", async () => {
    writeConfig("executor:\n  parallel: 0\n");
    await expect(checkConfig(tmpDir)).rejects.toThrow("executor.parallel");
  });

  test("throws actionable error for invalid poll_interval_minutes", async () => {
    writeConfig("executor:\n  poll_interval_minutes: 999\n");
    await expect(checkConfig(tmpDir)).rejects.toThrow(
      "executor.poll_interval_minutes",
    );
  });

  test("throws actionable error for config value with newline injection", async () => {
    writeConfig('linear:\n  team: "ENG\\nmalicious"\n');
    await expect(checkConfig(tmpDir)).rejects.toThrow("newline");
  });
});

describe("checkEnvVars", () => {
  const envKeys = [
    "LINEAR_API_KEY",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("passes when all required variables are set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = await checkEnvVars();
    expect(result).toContain("all set");
  });

  test("throws with clear message when LINEAR_API_KEY is missing", async () => {
    delete process.env.LINEAR_API_KEY;
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await expect(checkEnvVars()).rejects.toThrow("LINEAR_API_KEY");
  });

  test("throws with clear message when GITHUB_TOKEN is missing", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    delete process.env.GITHUB_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await expect(checkEnvVars()).rejects.toThrow("GITHUB_TOKEN");
  });

  test("throws when no Anthropic key variant is set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_TOKEN = "ghp_test";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    await expect(checkEnvVars()).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("passes when CLAUDE_API_KEY is set instead of ANTHROPIC_API_KEY", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_TOKEN = "ghp_test";
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_API_KEY = "sk-ant-test";
    const result = await checkEnvVars();
    expect(result).toContain("all set");
  });

  test("passes when CLAUDE_CODE_USE_BEDROCK is set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.GITHUB_TOKEN = "ghp_test";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const result = await checkEnvVars();
    expect(result).toContain("all set");
  });

  test("error message names all missing variables", async () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    await expect(checkEnvVars()).rejects.toThrow("LINEAR_API_KEY");
    await expect(checkEnvVars()).rejects.toThrow("GITHUB_TOKEN");
    await expect(checkEnvVars()).rejects.toThrow("ANTHROPIC_API_KEY");
  });
});

describe("checkWorktreeDir", () => {
  test("passes and reports path as writable", async () => {
    const result = await checkWorktreeDir(tmpDir);
    expect(result).toContain("writable");
  });

  test("creates the worktree directory if it does not exist", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const worktreeBase = resolve(tmpDir, ".claude", "worktrees");
    expect(existsSync(worktreeBase)).toBe(false);
    await checkWorktreeDir(tmpDir);
    expect(existsSync(worktreeBase)).toBe(true);
  });

  test("does not leave temporary files behind", async () => {
    const { readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    await checkWorktreeDir(tmpDir);
    const worktreeBase = resolve(tmpDir, ".claude", "worktrees");
    const files = readdirSync(worktreeBase);
    expect(files).toHaveLength(0);
  });
});

describe("checkPromptTemplates", () => {
  test("returns OK for all bundled templates", async () => {
    const result = await checkPromptTemplates(tmpDir);
    expect(result).toContain("OK");
  });

  test("result includes count and template names", async () => {
    const result = await checkPromptTemplates(tmpDir);
    expect(result).toMatch(/\d+ template\(s\) OK/);
  });
});
