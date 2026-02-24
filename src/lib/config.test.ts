import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

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

describe("loadConfig", () => {
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
    const dir = writeConfig(`
project:
  name: "${"x".repeat(201)}"
linear:
  team: ENG
  project: my-project
`);
    expect(() => loadConfig(dir)).toThrow(/project\.name/);
    expect(() => loadConfig(dir)).toThrow(/200/);
  });

  test("accepts values at exactly 200 characters", () => {
    const dir = writeConfig(`
project:
  name: "${"x".repeat(200)}"
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
});
