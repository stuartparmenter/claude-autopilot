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
  fixer_timeout_minutes: number;
  max_fixer_attempts: number;
  max_retries: number;
  inactivity_timeout_minutes: number;
  poll_interval_minutes: number;
  auto_approve_labels: string[];
  branch_pattern: string;
  commit_pattern: string;
  model: string;
  planning_model: string;
}

export interface AuditorConfig {
  schedule: "when_idle" | "daily" | "manual";
  min_ready_threshold: number;
  min_interval_minutes: number;
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
  prompt_dir: string;
}

export interface SandboxConfig {
  enabled: boolean;
  auto_allow_bash: boolean;
  network_restricted: boolean;
  extra_allowed_domains: string[];
}

export interface PersistenceConfig {
  enabled: boolean;
  db_path: string;
  retention_days: number;
}

export interface BudgetConfig {
  daily_limit_usd: number;
  monthly_limit_usd: number;
  per_agent_limit_usd: number;
  warn_at_percent: number;
}

export interface AutopilotConfig {
  linear: LinearConfig;
  executor: ExecutorConfig;
  auditor: AuditorConfig;
  github: GithubConfig;
  project: ProjectConfig;
  persistence: PersistenceConfig;
  sandbox: SandboxConfig;
  budget: BudgetConfig;
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
    fixer_timeout_minutes: 20,
    max_fixer_attempts: 3,
    max_retries: 3,
    inactivity_timeout_minutes: 10,
    poll_interval_minutes: 5,
    auto_approve_labels: [],
    branch_pattern: "autopilot/{{id}}",
    commit_pattern: "{{id}}: {{title}}",
    model: "sonnet",
    planning_model: "opus",
  },
  auditor: {
    schedule: "when_idle",
    min_ready_threshold: 5,
    min_interval_minutes: 60,
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
    prompt_dir: ".claude-autopilot/prompts",
  },
  persistence: {
    enabled: true,
    db_path: ".claude/autopilot.db",
    retention_days: 30,
  },
  sandbox: {
    enabled: true,
    auto_allow_bash: true,
    network_restricted: false,
    extra_allowed_domains: [],
  },
  budget: {
    daily_limit_usd: 0,
    monthly_limit_usd: 0,
    per_agent_limit_usd: 0,
    warn_at_percent: 80,
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

  if (
    typeof config.executor.poll_interval_minutes !== "number" ||
    Number.isNaN(config.executor.poll_interval_minutes) ||
    config.executor.poll_interval_minutes < 0.5 ||
    config.executor.poll_interval_minutes > 60
  ) {
    throw new Error(
      "Config validation error: executor.poll_interval_minutes must be a number between 0.5 and 60",
    );
  }

  if (
    typeof config.executor.parallel !== "number" ||
    Number.isNaN(config.executor.parallel) ||
    !Number.isInteger(config.executor.parallel) ||
    config.executor.parallel < 1 ||
    config.executor.parallel > 50
  ) {
    throw new Error(
      "Config validation error: executor.parallel must be an integer between 1 and 50",
    );
  }

  if (
    typeof config.executor.timeout_minutes !== "number" ||
    Number.isNaN(config.executor.timeout_minutes) ||
    config.executor.timeout_minutes < 1 ||
    config.executor.timeout_minutes > 480
  ) {
    throw new Error(
      "Config validation error: executor.timeout_minutes must be a number between 1 and 480",
    );
  }

  if (
    typeof config.executor.max_retries !== "number" ||
    Number.isNaN(config.executor.max_retries) ||
    !Number.isInteger(config.executor.max_retries) ||
    config.executor.max_retries < 0 ||
    config.executor.max_retries > 20
  ) {
    throw new Error(
      "Config validation error: executor.max_retries must be an integer between 0 and 20",
    );
  }

  if (
    typeof config.executor.inactivity_timeout_minutes !== "number" ||
    Number.isNaN(config.executor.inactivity_timeout_minutes) ||
    config.executor.inactivity_timeout_minutes < 1 ||
    config.executor.inactivity_timeout_minutes > 120
  ) {
    throw new Error(
      "Config validation error: executor.inactivity_timeout_minutes must be a number between 1 and 120",
    );
  }

  if (
    typeof config.auditor.min_interval_minutes !== "number" ||
    Number.isNaN(config.auditor.min_interval_minutes) ||
    config.auditor.min_interval_minutes < 0 ||
    config.auditor.min_interval_minutes > 1440
  ) {
    throw new Error(
      "Config validation error: auditor.min_interval_minutes must be a number between 0 and 1440",
    );
  }

  if (
    typeof config.auditor.min_ready_threshold !== "number" ||
    Number.isNaN(config.auditor.min_ready_threshold) ||
    !Number.isInteger(config.auditor.min_ready_threshold) ||
    config.auditor.min_ready_threshold < 0 ||
    config.auditor.min_ready_threshold > 1000
  ) {
    throw new Error(
      "Config validation error: auditor.min_ready_threshold must be an integer between 0 and 1000",
    );
  }

  if (
    typeof config.auditor.max_issues_per_run !== "number" ||
    Number.isNaN(config.auditor.max_issues_per_run) ||
    !Number.isInteger(config.auditor.max_issues_per_run) ||
    config.auditor.max_issues_per_run < 1 ||
    config.auditor.max_issues_per_run > 50
  ) {
    throw new Error(
      "Config validation error: auditor.max_issues_per_run must be an integer between 1 and 50",
    );
  }

  if (
    typeof config.executor.fixer_timeout_minutes !== "number" ||
    Number.isNaN(config.executor.fixer_timeout_minutes) ||
    config.executor.fixer_timeout_minutes < 1 ||
    config.executor.fixer_timeout_minutes > 120
  ) {
    throw new Error(
      "Config validation error: executor.fixer_timeout_minutes must be a number between 1 and 120",
    );
  }

  if (
    typeof config.executor.max_fixer_attempts !== "number" ||
    !Number.isInteger(config.executor.max_fixer_attempts) ||
    config.executor.max_fixer_attempts < 1 ||
    config.executor.max_fixer_attempts > 10
  ) {
    throw new Error(
      "Config validation error: executor.max_fixer_attempts must be an integer between 1 and 10",
    );
  }

  if (
    typeof config.budget.warn_at_percent !== "number" ||
    Number.isNaN(config.budget.warn_at_percent) ||
    config.budget.warn_at_percent < 0 ||
    config.budget.warn_at_percent > 100
  ) {
    throw new Error(
      "Config validation error: budget.warn_at_percent must be a number between 0 and 100",
    );
  }

  for (const field of [
    "daily_limit_usd",
    "monthly_limit_usd",
    "per_agent_limit_usd",
  ] as const) {
    const value = config.budget[field];
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      throw new Error(
        `Config validation error: budget.${field} must be a non-negative number`,
      );
    }
  }

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
