import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { fatal } from "./logger";

export interface LinearConfig {
  team: string;
  project: string;
  states: {
    triage: string;
    ready: string;
    in_progress: string;
    in_review: string;
    done: string;
    blocked: string;
  };
}

// Resolved IDs from Linear API — used at runtime, not in config
export interface LinearIds {
  teamId: string;
  teamKey: string;
  projectId: string;
  projectName: string;
  states: {
    triage: string;
    ready: string;
    in_progress: string;
    in_review: string;
    done: string;
    blocked: string;
  };
}

export interface ExecutorConfig {
  parallel: number;
  timeout_minutes: number;
  inactivity_timeout_minutes: number;
  auto_approve_labels: string[];
  branch_pattern: string;
  commit_pattern: string;
  model: string;
  planning_model: string;
}

export interface AuditorConfig {
  schedule: "when_idle" | "daily" | "manual";
  min_ready_threshold: number;
  max_issues_per_run: number;
  use_agent_teams: boolean;
  skip_triage: boolean;
  scan_dimensions: string[];
  brainstorm_features: boolean;
  brainstorm_dimensions: string[];
  max_ideas_per_run: number;
}

export interface GithubConfig {
  repo: string; // "owner/repo" override — empty = auto-detect from git remote
  automerge: boolean; // Enable auto-merge on PRs created by the executor
}

export interface ProjectConfig {
  name: string;
}

export interface AutopilotConfig {
  linear: LinearConfig;
  executor: ExecutorConfig;
  auditor: AuditorConfig;
  github: GithubConfig;
  project: ProjectConfig;
}

export const DEFAULTS: AutopilotConfig = {
  linear: {
    team: "",
    project: "",
    states: {
      triage: "Triage",
      ready: "Todo",
      in_progress: "In Progress",
      in_review: "In Review",
      done: "Done",
      blocked: "Backlog",
    },
  },
  executor: {
    parallel: 3,
    timeout_minutes: 30,
    inactivity_timeout_minutes: 10,
    auto_approve_labels: [],
    branch_pattern: "autopilot/{{id}}",
    commit_pattern: "{{id}}: {{title}}",
    model: "sonnet",
    planning_model: "opus",
  },
  auditor: {
    schedule: "when_idle",
    min_ready_threshold: 5,
    max_issues_per_run: 10,
    use_agent_teams: true,
    skip_triage: true,
    scan_dimensions: [
      "test-coverage",
      "error-handling",
      "performance",
      "security",
      "code-quality",
      "dependency-health",
      "documentation",
    ],
    brainstorm_features: true,
    brainstorm_dimensions: [
      "user-facing-features",
      "developer-experience",
      "integrations",
      "scalability",
    ],
    max_ideas_per_run: 5,
  },
  github: {
    repo: "",
    automerge: false,
  },
  project: {
    name: "",
  },
};

export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const targetVal = (target as Record<string, unknown>)[key];
    const sourceVal = source[key];
    if (
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal) &&
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      (result as Record<string, unknown>)[key] = sourceVal;
    }
  }
  return result;
}

function validateConfigStrings(config: AutopilotConfig): void {
  const fields: Array<[string, string]> = [
    ["project.name", config.project.name],
    ["linear.team", config.linear.team],
    ["linear.project", config.linear.project],
    ["linear.states.triage", config.linear.states.triage],
    ["linear.states.ready", config.linear.states.ready],
    ["linear.states.in_progress", config.linear.states.in_progress],
    ["linear.states.in_review", config.linear.states.in_review],
    ["linear.states.done", config.linear.states.done],
    ["linear.states.blocked", config.linear.states.blocked],
  ];

  for (const [key, value] of fields) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `Config validation error: "${key}" must not contain newline characters`,
      );
    }
    if (value.length > 200) {
      throw new Error(
        `Config validation error: "${key}" exceeds the maximum length of 200 characters`,
      );
    }
  }
}

export function loadConfig(projectPath: string): AutopilotConfig {
  const configPath = resolve(projectPath, ".claude-autopilot.yml");
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun 'bun run setup' first.`,
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;

  const config = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as AutopilotConfig;

  validateConfigStrings(config);

  return config;
}

export function resolveProjectPath(arg?: string): string {
  if (!arg) {
    fatal("Usage: bun run <script> <project-path>");
  }
  const resolved = resolve(arg);
  if (!existsSync(resolved)) {
    fatal(`Project path does not exist: ${resolved}`);
  }
  return resolved;
}
