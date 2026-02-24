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
    expect(config.auditor.brainstorm_dimensions).toEqual(["user-facing-features"]);
  });
});
