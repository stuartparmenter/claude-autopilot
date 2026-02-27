import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { fatal, warn } from "./logger";

export interface OAuthConfig {
  client_id: string;
  client_secret: string;
}

export interface LinearConfig {
  team: string;
  initiative: string;
  labels: string[];
  projects: string[];
  oauth?: OAuthConfig;
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
  initiativeId?: string;
  initiativeName?: string;
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
  stale_timeout_minutes: number;
  auto_approve_labels: string[];
  branch_pattern: string;
  commit_pattern: string;
  model: string;
}

export interface PlanningConfig {
  schedule: "when_idle" | "daily" | "manual";
  min_ready_threshold: number;
  min_interval_minutes: number;
  max_issues_per_run: number;
  timeout_minutes: number;
  inactivity_timeout_minutes: number;
  model: string;
}

export interface MonitorConfig {
  respond_to_reviews: boolean;
  review_responder_timeout_minutes: number;
}

export interface GithubConfig {
  repo: string; // "owner/repo" override — empty = auto-detect from git remote
  automerge: boolean; // Enable auto-merge on PRs created by the executor
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

export interface ProjectsConfig {
  enabled: boolean;
  poll_interval_minutes: number;
  backlog_review_interval_minutes: number;
  max_active_projects: number;
  timeout_minutes: number;
  model: string;
}

export interface ReviewerConfig {
  enabled: boolean;
  min_interval_minutes: number;
  min_runs_before_review: number;
  timeout_minutes: number;
  model: string;
  max_issues_per_review: number;
}

export interface GitConfig {
  user_name: string;
  user_email: string;
}

export interface AutopilotConfig {
  linear: LinearConfig;
  executor: ExecutorConfig;
  planning: PlanningConfig;
  projects: ProjectsConfig;
  reviewer: ReviewerConfig;
  monitor: MonitorConfig;
  github: GithubConfig;
  git: GitConfig;
  persistence: PersistenceConfig;
  sandbox: SandboxConfig;
  budget: BudgetConfig;
}

export const DEFAULTS: AutopilotConfig = {
  linear: {
    team: "",
    initiative: "",
    labels: [],
    projects: [],
    oauth: undefined,
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
    timeout_minutes: 60,
    fixer_timeout_minutes: 60,
    max_fixer_attempts: 3,
    max_retries: 3,
    inactivity_timeout_minutes: 10,
    poll_interval_minutes: 5,
    stale_timeout_minutes: 15,
    auto_approve_labels: [],
    branch_pattern: "autopilot/{{id}}",
    commit_pattern: "{{id}}: {{title}}",
    model: "sonnet",
  },
  planning: {
    schedule: "when_idle",
    min_ready_threshold: 5,
    min_interval_minutes: 60,
    max_issues_per_run: 5,
    timeout_minutes: 90,
    inactivity_timeout_minutes: 30,
    model: "opus",
  },
  monitor: {
    respond_to_reviews: false,
    review_responder_timeout_minutes: 20,
  },
  github: {
    repo: "",
    automerge: false,
  },
  git: {
    user_name: "autopilot[bot]",
    user_email: "autopilot[bot]@users.noreply.github.com",
  },
  persistence: {
    enabled: true,
    db_path: ".claude/autopilot.db",
    retention_days: 30,
  },
  projects: {
    enabled: true,
    poll_interval_minutes: 10,
    backlog_review_interval_minutes: 240,
    max_active_projects: 5,
    timeout_minutes: 60,
    model: "opus",
  },
  reviewer: {
    enabled: false,
    min_interval_minutes: 120,
    min_runs_before_review: 10,
    timeout_minutes: 60,
    model: "opus",
    max_issues_per_review: 5,
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

export function collectUnknownKeys(
  source: Record<string, unknown>,
  reference: Record<string, unknown>,
  prefix = "",
): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in reference)) {
      unknown.push(path);
    } else {
      const sourceVal = source[key];
      const refVal = reference[key];
      if (
        sourceVal &&
        typeof sourceVal === "object" &&
        !Array.isArray(sourceVal) &&
        refVal &&
        typeof refVal === "object" &&
        !Array.isArray(refVal)
      ) {
        unknown.push(
          ...collectUnknownKeys(
            sourceVal as Record<string, unknown>,
            refVal as Record<string, unknown>,
            path,
          ),
        );
      }
    }
  }
  return unknown;
}

function validateConfigStrings(config: AutopilotConfig): void {
  const fields: Array<[string, string]> = [
    ["linear.team", config.linear.team],
    ["linear.initiative", config.linear.initiative],
    ["linear.states.triage", config.linear.states.triage],
    ["linear.states.ready", config.linear.states.ready],
    ["linear.states.in_progress", config.linear.states.in_progress],
    ["linear.states.in_review", config.linear.states.in_review],
    ["linear.states.done", config.linear.states.done],
    ["linear.states.blocked", config.linear.states.blocked],
    ["git.user_name", config.git.user_name],
    ["git.user_email", config.git.user_email],
  ];

  for (const [key, value] of fields) {
    if (!value) continue;
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

  for (const [arrayKey, array] of [
    ["linear.labels", config.linear.labels],
    ["linear.projects", config.linear.projects],
  ] as [string, string[]][]) {
    for (let i = 0; i < array.length; i++) {
      const item = array[i];
      if (typeof item !== "string" || item.trim() === "") {
        throw new Error(
          `Config validation error: "${arrayKey}[${i}]" must not be an empty string`,
        );
      }
    }
  }
}

export function loadConfig(projectPath: string): AutopilotConfig {
  const configPath = resolve(projectPath, ".autopilot.yml");
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

  const unknownKeys = collectUnknownKeys(
    parsed,
    DEFAULTS as unknown as Record<string, unknown>,
  );
  for (const key of unknownKeys) {
    warn(
      `Unknown config key "${key}" in .autopilot.yml — this key has no effect. Check for typos.`,
    );
  }

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
    typeof config.planning.min_interval_minutes !== "number" ||
    Number.isNaN(config.planning.min_interval_minutes) ||
    config.planning.min_interval_minutes < 0 ||
    config.planning.min_interval_minutes > 1440
  ) {
    throw new Error(
      "Config validation error: planning.min_interval_minutes must be a number between 0 and 1440",
    );
  }

  if (
    typeof config.planning.min_ready_threshold !== "number" ||
    Number.isNaN(config.planning.min_ready_threshold) ||
    !Number.isInteger(config.planning.min_ready_threshold) ||
    config.planning.min_ready_threshold < 0 ||
    config.planning.min_ready_threshold > 1000
  ) {
    throw new Error(
      "Config validation error: planning.min_ready_threshold must be an integer between 0 and 1000",
    );
  }

  if (
    typeof config.planning.max_issues_per_run !== "number" ||
    Number.isNaN(config.planning.max_issues_per_run) ||
    !Number.isInteger(config.planning.max_issues_per_run) ||
    config.planning.max_issues_per_run < 1 ||
    config.planning.max_issues_per_run > 50
  ) {
    throw new Error(
      "Config validation error: planning.max_issues_per_run must be an integer between 1 and 50",
    );
  }

  if (
    typeof config.planning.inactivity_timeout_minutes !== "number" ||
    Number.isNaN(config.planning.inactivity_timeout_minutes) ||
    config.planning.inactivity_timeout_minutes < 1 ||
    config.planning.inactivity_timeout_minutes > 120
  ) {
    throw new Error(
      "Config validation error: planning.inactivity_timeout_minutes must be a number between 1 and 120",
    );
  }

  if (
    typeof config.reviewer.min_interval_minutes !== "number" ||
    Number.isNaN(config.reviewer.min_interval_minutes) ||
    config.reviewer.min_interval_minutes < 0 ||
    config.reviewer.min_interval_minutes > 1440
  ) {
    throw new Error(
      "Config validation error: reviewer.min_interval_minutes must be a number between 0 and 1440",
    );
  }

  if (
    typeof config.reviewer.min_runs_before_review !== "number" ||
    Number.isNaN(config.reviewer.min_runs_before_review) ||
    !Number.isInteger(config.reviewer.min_runs_before_review) ||
    config.reviewer.min_runs_before_review < 1 ||
    config.reviewer.min_runs_before_review > 1000
  ) {
    throw new Error(
      "Config validation error: reviewer.min_runs_before_review must be an integer between 1 and 1000",
    );
  }

  if (
    typeof config.reviewer.max_issues_per_review !== "number" ||
    Number.isNaN(config.reviewer.max_issues_per_review) ||
    !Number.isInteger(config.reviewer.max_issues_per_review) ||
    config.reviewer.max_issues_per_review < 1 ||
    config.reviewer.max_issues_per_review > 50
  ) {
    throw new Error(
      "Config validation error: reviewer.max_issues_per_review must be an integer between 1 and 50",
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
    typeof config.executor.stale_timeout_minutes !== "number" ||
    Number.isNaN(config.executor.stale_timeout_minutes) ||
    !Number.isInteger(config.executor.stale_timeout_minutes) ||
    config.executor.stale_timeout_minutes < 5 ||
    config.executor.stale_timeout_minutes > 120
  ) {
    throw new Error(
      "Config validation error: executor.stale_timeout_minutes must be an integer between 5 and 120",
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
