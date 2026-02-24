import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

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
}

export interface ProjectConfig {
  name: string;
}

export interface NotificationsConfig {
  slack_webhook: string;
  notify_on: string[];
}

export interface AutopilotConfig {
  linear: LinearConfig;
  executor: ExecutorConfig;
  auditor: AuditorConfig;
  project: ProjectConfig;
  notifications: NotificationsConfig;
}

const DEFAULTS: AutopilotConfig = {
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
  },
  project: {
    name: "",
  },
  notifications: {
    slack_webhook: "",
    notify_on: [
      "executor_complete",
      "executor_blocked",
      "auditor_complete",
      "error",
    ],
  },
};

function deepMerge<T extends Record<string, unknown>>(
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

export function loadConfig(projectPath: string): AutopilotConfig {
  const configPath = resolve(projectPath, ".claude-autopilot.yml");
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun 'bun run setup' first.`,
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;

  return deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as AutopilotConfig;
}

export function resolveProjectPath(arg?: string): string {
  if (!arg) {
    console.error("Usage: bun run <script> <project-path>");
    process.exit(1);
  }
  const resolved = resolve(arg);
  if (!existsSync(resolved)) {
    console.error(`Project path does not exist: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}
