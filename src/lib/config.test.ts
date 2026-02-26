import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, deepMerge, loadConfig } from "./config";

let tmpDir: string;

function writeConfig(content: string): string {
  writeFileSync(join(tmpDir, ".claude-autopilot.yml"), content, "utf-8");
  return tmpDir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("deepMerge", () => {
  test("empty source returns target unchanged", () => {
    const result = deepMerge({ a: 1 }, {});
    expect(result).toEqual({ a: 1 });
  });

  test("scalar override replaces target value", () => {
    const result = deepMerge({ a: 1, b: 2 }, { a: 99 });
    expect(result).toEqual({ a: 99, b: 2 });
  });

  test("deep nested objects are merged recursively", () => {
    const result = deepMerge({ a: { x: 1, y: 2 } }, { a: { x: 10 } });
    expect(result).toEqual({ a: { x: 10, y: 2 } });
  });

  test("arrays are replaced not merged", () => {
    const result = deepMerge({ arr: [1, 2, 3] }, { arr: [4, 5] });
    expect(result).toEqual({ arr: [4, 5] });
  });

  test("undefined source values are ignored", () => {
    const result = deepMerge({ a: 1 }, { a: undefined });
    expect(result).toEqual({ a: 1 });
  });

  test("new keys in source are added to result", () => {
    const target: Record<string, unknown> = { a: 1 };
    const result = deepMerge(target, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("target is not mutated", () => {
    const target = { a: 1 };
    deepMerge(target, { a: 2 });
    expect(target).toEqual({ a: 1 });
  });

  test("3-level deep nesting merges correctly", () => {
    const result = deepMerge(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { c: 99 } } },
    );
    expect(result).toEqual({ a: { b: { c: 99, d: 2 } } });
  });

  test("__proto__ key does not pollute Object.prototype", () => {
    const malicious: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    );
    deepMerge({ a: 1 }, malicious);
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("loadConfig", () => {
  test("throws on missing config file", () => {
    expect(() => loadConfig("/nonexistent/path")).toThrow(
      "Config file not found",
    );
  });

  test("minimal YAML fills in defaults", () => {
    writeFileSync(
      join(tmpDir, ".claude-autopilot.yml"),
      "linear:\n  team: myteam\n  project: myproject\n",
    );
    const config = loadConfig(tmpDir);
    expect(config.linear.team).toBe("myteam");
    expect(config.linear.project).toBe("myproject");
    expect(config.executor.parallel).toBe(3);
    expect(config.executor.timeout_minutes).toBe(30);
  });

  test("specific overrides are preserved", () => {
    writeFileSync(
      join(tmpDir, ".claude-autopilot.yml"),
      "executor:\n  parallel: 5\n  timeout_minutes: 60\n",
    );
    const config = loadConfig(tmpDir);
    expect(config.executor.parallel).toBe(5);
    expect(config.executor.timeout_minutes).toBe(60);
    expect(config.auditor.schedule).toBe("when_idle");
  });

  test("empty YAML returns defaults", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  test("nested state overrides are merged", () => {
    writeFileSync(
      join(tmpDir, ".claude-autopilot.yml"),
      "linear:\n  states:\n    ready: Backlog\n",
    );
    const config = loadConfig(tmpDir);
    expect(config.linear.states.ready).toBe("Backlog");
    expect(config.linear.states.done).toBe("Done");
  });

  test("loads a valid config without throwing", () => {
    const dir = writeConfig(`
project:
  name: My Project
linear:
  team: ENG
  project: my-project
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("throws if project.name contains a newline", () => {
    const dir = writeConfig(`
project:
  name: |
    foo
    bar
linear:
  team: ENG
  project: my-project
`);
    expect(() => loadConfig(dir)).toThrow(/project\.name/);
    expect(() => loadConfig(dir)).toThrow(/newline/);
  });

  test("throws if linear.team contains a newline", () => {
    const dir = writeConfig(`
project:
  name: My Project
linear:
  team: |
    ENG
    EVIL
  project: my-project
`);
    expect(() => loadConfig(dir)).toThrow(/linear\.team/);
  });

  test("throws if a config string exceeds 200 characters", () => {
    const longName = "x".repeat(201);
    const dir = writeConfig(`
project:
  name: "${longName}"
linear:
  team: ENG
  project: my-project
`);
    expect(() => loadConfig(dir)).toThrow(/project\.name/);
    expect(() => loadConfig(dir)).toThrow(/200/);
  });

  test("accepts values at exactly 200 characters", () => {
    const exactName = "x".repeat(200);
    const dir = writeConfig(`
project:
  name: "${exactName}"
linear:
  team: ENG
  project: my-project
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("accepts legitimate state names", () => {
    const dir = writeConfig(`
project:
  name: My Project (v2)
linear:
  team: ENG
  project: my-project
  states:
    triage: Triage
    ready: Todo
    in_progress: In Progress
    in_review: In Review
    done: Done
    blocked: Backlog
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("throws if a state name contains a newline", () => {
    const dir = writeConfig(`
project:
  name: My Project
linear:
  team: ENG
  project: my-project
  states:
    ready: |
      Todo
      EVIL
`);
    expect(() => loadConfig(dir)).toThrow(/linear\.states\.ready/);
  });

  test("brainstorm config defaults are set", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config.auditor.brainstorm_features).toBe(true);
    expect(config.auditor.brainstorm_dimensions).toEqual([
      "user-facing-features",
      "developer-experience",
      "integrations",
      "scalability",
    ]);
    expect(config.auditor.max_ideas_per_run).toBe(5);
  });

  test("brainstorm config can be overridden", () => {
    const dir = writeConfig(`
auditor:
  brainstorm_features: false
  max_ideas_per_run: 3
  brainstorm_dimensions:
    - user-facing-features
`);
    const config = loadConfig(dir);
    expect(config.auditor.brainstorm_features).toBe(false);
    expect(config.auditor.max_ideas_per_run).toBe(3);
    expect(config.auditor.brainstorm_dimensions).toEqual([
      "user-facing-features",
    ]);
  });

  test("poll_interval_minutes defaults to 5", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config.executor.poll_interval_minutes).toBe(5);
  });

  test("poll_interval_minutes can be overridden", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: 2
`);
    const config = loadConfig(dir);
    expect(config.executor.poll_interval_minutes).toBe(2);
  });

  test("poll_interval_minutes accepts boundary value 0.5", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: 0.5
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("poll_interval_minutes accepts boundary value 60", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: 60
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("poll_interval_minutes throws below 0.5", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: 0.4
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.poll_interval_minutes must be a number between 0.5 and 60",
    );
  });

  test("poll_interval_minutes throws above 60", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: 61
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.poll_interval_minutes must be a number between 0.5 and 60",
    );
  });

  test("poll_interval_minutes throws for non-numeric value", () => {
    const dir = writeConfig(`
executor:
  poll_interval_minutes: "fast"
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.poll_interval_minutes must be a number between 0.5 and 60",
    );
  });

  test("executor.parallel defaults to 3", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config.executor.parallel).toBe(3);
  });

  test("executor.parallel throws below 1", () => {
    const dir = writeConfig(`
executor:
  parallel: 0
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.parallel must be an integer between 1 and 50",
    );
  });

  test("executor.parallel throws above 50", () => {
    const dir = writeConfig(`
executor:
  parallel: 51
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.parallel must be an integer between 1 and 50",
    );
  });

  test("executor.parallel throws for non-integer value", () => {
    const dir = writeConfig(`
executor:
  parallel: 2.5
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.parallel must be an integer between 1 and 50",
    );
  });

  test("executor.parallel accepts boundary value 1", () => {
    const dir = writeConfig(`
executor:
  parallel: 1
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.parallel accepts boundary value 50", () => {
    const dir = writeConfig(`
executor:
  parallel: 50
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.timeout_minutes throws below 1", () => {
    const dir = writeConfig(`
executor:
  timeout_minutes: 0
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.timeout_minutes must be a number between 1 and 480",
    );
  });

  test("executor.timeout_minutes throws above 480", () => {
    const dir = writeConfig(`
executor:
  timeout_minutes: 481
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.timeout_minutes must be a number between 1 and 480",
    );
  });

  test("executor.timeout_minutes accepts boundary value 1", () => {
    const dir = writeConfig(`
executor:
  timeout_minutes: 1
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.timeout_minutes accepts boundary value 480", () => {
    const dir = writeConfig(`
executor:
  timeout_minutes: 480
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.max_retries throws below 0", () => {
    const dir = writeConfig(`
executor:
  max_retries: -1
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.max_retries must be an integer between 0 and 20",
    );
  });

  test("executor.max_retries throws above 20", () => {
    const dir = writeConfig(`
executor:
  max_retries: 21
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.max_retries must be an integer between 0 and 20",
    );
  });

  test("executor.max_retries accepts boundary value 0", () => {
    const dir = writeConfig(`
executor:
  max_retries: 0
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.max_retries accepts boundary value 20", () => {
    const dir = writeConfig(`
executor:
  max_retries: 20
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.inactivity_timeout_minutes throws below 1", () => {
    const dir = writeConfig(`
executor:
  inactivity_timeout_minutes: 0
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.inactivity_timeout_minutes must be a number between 1 and 120",
    );
  });

  test("executor.inactivity_timeout_minutes throws above 120", () => {
    const dir = writeConfig(`
executor:
  inactivity_timeout_minutes: 121
`);
    expect(() => loadConfig(dir)).toThrow(
      "executor.inactivity_timeout_minutes must be a number between 1 and 120",
    );
  });

  test("executor.inactivity_timeout_minutes accepts boundary value 1", () => {
    const dir = writeConfig(`
executor:
  inactivity_timeout_minutes: 1
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("executor.inactivity_timeout_minutes accepts boundary value 120", () => {
    const dir = writeConfig(`
executor:
  inactivity_timeout_minutes: 120
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("auditor.min_ready_threshold throws below 0", () => {
    const dir = writeConfig(`
auditor:
  min_ready_threshold: -1
`);
    expect(() => loadConfig(dir)).toThrow(
      "auditor.min_ready_threshold must be an integer between 0 and 1000",
    );
  });

  test("auditor.min_ready_threshold throws above 1000", () => {
    const dir = writeConfig(`
auditor:
  min_ready_threshold: 1001
`);
    expect(() => loadConfig(dir)).toThrow(
      "auditor.min_ready_threshold must be an integer between 0 and 1000",
    );
  });

  test("auditor.min_ready_threshold accepts boundary value 0", () => {
    const dir = writeConfig(`
auditor:
  min_ready_threshold: 0
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("auditor.min_ready_threshold accepts boundary value 1000", () => {
    const dir = writeConfig(`
auditor:
  min_ready_threshold: 1000
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("auditor.max_issues_per_run throws below 1", () => {
    const dir = writeConfig(`
auditor:
  max_issues_per_run: 0
`);
    expect(() => loadConfig(dir)).toThrow(
      "auditor.max_issues_per_run must be an integer between 1 and 50",
    );
  });

  test("auditor.max_issues_per_run throws above 50", () => {
    const dir = writeConfig(`
auditor:
  max_issues_per_run: 51
`);
    expect(() => loadConfig(dir)).toThrow(
      "auditor.max_issues_per_run must be an integer between 1 and 50",
    );
  });

  test("auditor.max_issues_per_run accepts boundary value 1", () => {
    const dir = writeConfig(`
auditor:
  max_issues_per_run: 1
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("auditor.max_issues_per_run accepts boundary value 50", () => {
    const dir = writeConfig(`
auditor:
  max_issues_per_run: 50
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("all default values pass validation", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    expect(() => loadConfig(tmpDir)).not.toThrow();
  });

  test("sandbox defaults are applied when YAML omits them", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config.sandbox).toEqual({
      enabled: true,
      auto_allow_bash: true,
      network_restricted: false,
      extra_allowed_domains: [],
    });
  });

  test("sandbox config can be overridden", () => {
    const dir = writeConfig(`
sandbox:
  enabled: false
  network_restricted: true
  extra_allowed_domains:
    - custom.example.com
`);
    const config = loadConfig(dir);
    expect(config.sandbox.enabled).toBe(false);
    expect(config.sandbox.auto_allow_bash).toBe(true);
    expect(config.sandbox.network_restricted).toBe(true);
    expect(config.sandbox.extra_allowed_domains).toEqual([
      "custom.example.com",
    ]);
  });

  test("budget defaults are applied when YAML omits them", () => {
    writeFileSync(join(tmpDir, ".claude-autopilot.yml"), "");
    const config = loadConfig(tmpDir);
    expect(config.budget).toEqual({
      daily_limit_usd: 0,
      monthly_limit_usd: 0,
      per_agent_limit_usd: 0,
      warn_at_percent: 80,
    });
  });

  test("budget config can be overridden", () => {
    const dir = writeConfig(`
budget:
  daily_limit_usd: 10
  monthly_limit_usd: 200
  per_agent_limit_usd: 0.5
  warn_at_percent: 90
`);
    const config = loadConfig(dir);
    expect(config.budget.daily_limit_usd).toBe(10);
    expect(config.budget.monthly_limit_usd).toBe(200);
    expect(config.budget.per_agent_limit_usd).toBe(0.5);
    expect(config.budget.warn_at_percent).toBe(90);
  });

  test("budget partial override preserves other defaults", () => {
    const dir = writeConfig(`
budget:
  daily_limit_usd: 5
`);
    const config = loadConfig(dir);
    expect(config.budget.daily_limit_usd).toBe(5);
    expect(config.budget.monthly_limit_usd).toBe(0);
    expect(config.budget.per_agent_limit_usd).toBe(0);
    expect(config.budget.warn_at_percent).toBe(80);
  });

  test("budget.warn_at_percent throws above 100", () => {
    const dir = writeConfig(`
budget:
  warn_at_percent: 101
`);
    expect(() => loadConfig(dir)).toThrow(
      "budget.warn_at_percent must be a number between 0 and 100",
    );
  });

  test("budget.warn_at_percent throws below 0", () => {
    const dir = writeConfig(`
budget:
  warn_at_percent: -1
`);
    expect(() => loadConfig(dir)).toThrow(
      "budget.warn_at_percent must be a number between 0 and 100",
    );
  });

  test("budget.warn_at_percent accepts boundary value 0", () => {
    const dir = writeConfig(`
budget:
  warn_at_percent: 0
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("budget.warn_at_percent accepts boundary value 100", () => {
    const dir = writeConfig(`
budget:
  warn_at_percent: 100
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test("budget.daily_limit_usd throws if negative", () => {
    const dir = writeConfig(`
budget:
  daily_limit_usd: -1
`);
    expect(() => loadConfig(dir)).toThrow(
      "budget.daily_limit_usd must be a non-negative number",
    );
  });

  test("budget.monthly_limit_usd throws if negative", () => {
    const dir = writeConfig(`
budget:
  monthly_limit_usd: -0.01
`);
    expect(() => loadConfig(dir)).toThrow(
      "budget.monthly_limit_usd must be a non-negative number",
    );
  });

  test("budget.per_agent_limit_usd throws if negative", () => {
    const dir = writeConfig(`
budget:
  per_agent_limit_usd: -5
`);
    expect(() => loadConfig(dir)).toThrow(
      "budget.per_agent_limit_usd must be a non-negative number",
    );
  });

  test("budget USD fields accept zero (disabled)", () => {
    const dir = writeConfig(`
budget:
  daily_limit_usd: 0
  monthly_limit_usd: 0
  per_agent_limit_usd: 0
`);
    expect(() => loadConfig(dir)).not.toThrow();
  });
});
