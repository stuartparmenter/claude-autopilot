import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type AgentDefinition,
  createSdkMcpServer,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type PreToolUseHookInput,
  type SdkPluginConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SandboxConfig } from "./config";
import { enableAutoMerge } from "./github";
import { createProjectStatusUpdate } from "./linear";
import { warn } from "./logger";

/** Domains agents always need access to when network is restricted. */
export const SANDBOX_BASE_DOMAINS = [
  "github.com",
  "api.github.com",
  "api.githubcopilot.com",
  "mcp.linear.app",
];

export function buildMcpServers(linearToken?: string): Record<string, unknown> {
  const token = linearToken ?? process.env.LINEAR_API_KEY;
  if (!token) {
    throw new Error("No Linear token available for MCP server");
  }

  const autoMergeTool = tool(
    "enable_auto_merge",
    "Enable auto-merge on a GitHub pull request. Automatically detects the repo's allowed merge method. Requires the repo to have auto-merge enabled and branch protection rules configured.",
    {
      owner: z.string().describe("Repository owner (e.g. 'octocat')"),
      repo: z.string().describe("Repository name (e.g. 'hello-world')"),
      pull_number: z.number().describe("Pull request number"),
    },
    async (args) => {
      const msg = await enableAutoMerge(
        args.owner,
        args.repo,
        args.pull_number,
      );
      return { content: [{ type: "text" as const, text: msg }] };
    },
  );

  const projectStatusUpdateTool = tool(
    "save_project_status_update",
    "Post a status update on a Linear project. Use this instead of save_status_update when posting project-level (not initiative-level) updates.",
    {
      projectId: z
        .string()
        .describe("The Linear project ID (UUID) to post the update on"),
      body: z.string().describe("The status update content in markdown format"),
      health: z
        .enum(["onTrack", "atRisk", "offTrack"])
        .optional()
        .describe("The health of the project at the time of the update"),
    },
    async (args) => {
      const id = await createProjectStatusUpdate({
        projectId: args.projectId,
        body: args.body,
        health: args.health,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Project status update created (id: ${id})`,
          },
        ],
      };
    },
  );

  return {
    linear: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer ${token}` },
    },
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
    },
    autopilot: createSdkMcpServer({
      name: "autopilot",
      tools: [autoMergeTool, projectStatusUpdateTool],
    }),
  };
}

/** Vars the agent subprocess needs. The SDK's `env` replaces process.env
 *  entirely, so we only forward what's required. */
const AGENT_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
];

/**
 * Build the env for agent subprocesses.
 * Only allowlisted vars + the teams flag are forwarded.
 */
export function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    if (process.env[key]) {
      env[key] = process.env[key] as string;
    }
  }
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  // Block global/system gitconfig so no settings leak into the sandbox
  // (GPG signing, credential helpers, hooks, etc.). Agents only use the
  // clone's local .git/config which we control.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

export function buildSandboxConfig(
  sandbox: SandboxConfig,
  agentTmpDir: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    enabled: true,
    autoAllowBashIfSandboxed: sandbox.auto_allow_bash ?? true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [
        // Allow /tmp broadly, plus the specific agent tmpdir.
        // The explicit agentTmpDir entry ensures this agent's temp directory
        // is writable even if the SDK/sandbox layer drops the broad "/tmp".
        "/tmp",
        agentTmpDir,
        // Teams need write access to these dirs for coordination files
        resolve(homedir(), ".claude/teams"),
        resolve(homedir(), ".claude/tasks"),
      ],
    },
  };
  if (sandbox.network_restricted) {
    const network: Record<string, unknown> = {
      allowedDomains: [
        ...SANDBOX_BASE_DOMAINS,
        ...(sandbox.extra_allowed_domains ?? []),
      ],
    };
    // Allow SSH agent socket for git commit signing
    if (process.env.SSH_AUTH_SOCK) {
      network.allowUnixSockets = [process.env.SSH_AUTH_SOCK];
    }
    config.network = network;
  }
  return config;
}

/**
 * Build a PreToolUse hook that denies Write/Edit/NotebookEdit to paths
 * outside the agent's working directory and /tmp.
 * Replaces the shell-based sandbox-guard plugin with a programmatic hook
 * so denials are logged to our activity stream.
 */
export function buildSandboxGuardHook(
  agentCwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const toolInput = pre.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (!filePath) return {};

    let resolved = filePath;
    if (resolved.startsWith("~")) {
      resolved = `${homedir()}${resolved.slice(1)}`;
    }
    if (!resolved.startsWith("/")) {
      resolved = resolve(agentCwd, resolved);
    }
    resolved = resolve(resolved);

    const normalCwd = resolve(agentCwd);

    // Allow: under cwd
    if (resolved.startsWith(`${normalCwd}/`) || resolved === normalCwd) {
      return {};
    }
    // Allow: under /tmp
    if (resolved.startsWith("/tmp/") || resolved === "/tmp") {
      return {};
    }
    // Allow: under agent's TMPDIR
    if (process.env.TMPDIR) {
      const normalTmp = resolve(process.env.TMPDIR);
      if (resolved.startsWith(`${normalTmp}/`) || resolved === normalTmp) {
        return {};
      }
    }
    // Allow: ~/.claude/teams and ~/.claude/tasks (team coordination)
    const claudeTeams = resolve(homedir(), ".claude/teams");
    const claudeTasks = resolve(homedir(), ".claude/tasks");
    if (
      resolved.startsWith(`${claudeTeams}/`) ||
      resolved === claudeTeams ||
      resolved.startsWith(`${claudeTasks}/`) ||
      resolved === claudeTasks
    ) {
      return {};
    }

    warn(
      `[sandbox-guard] DENIED ${pre.tool_name} to '${filePath}' (cwd: ${agentCwd})`,
    );

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `[sandbox-guard] ${pre.tool_name} to '${filePath}' blocked: path is outside the working directory (${agentCwd}). Only write to files within your working directory or /tmp.`,
      },
    };
  };

  return {
    PreToolUse: [
      {
        matcher: "Write|Edit|NotebookEdit",
        hooks: [guard],
      },
    ],
  };
}

/**
 * Build the base query options object for the Agent SDK.
 * Does not include sandbox config (added conditionally) or clone cwd override.
 */
export function buildQueryOptions(
  cwd: string,
  controller: AbortController,
  stderr: (data: string) => void,
  extras: {
    mcpServers?: Record<string, unknown>;
    model?: string;
    agents?: Record<string, AgentDefinition>;
    plugins?: SdkPluginConfig[];
  } = {},
): Record<string, unknown> {
  return {
    cwd,
    abortController: controller,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: buildAgentEnv(),
    stderr,
    // NOTE: SDK Setup hooks don't fire reliably for programmatic callbacks,
    // so we release the spawn slot on the init stream message instead.
    ...(extras.mcpServers && { mcpServers: extras.mcpServers }),
    ...(extras.model && { model: extras.model }),
    ...(extras.agents && { agents: extras.agents }),
    ...(extras.plugins && { plugins: extras.plugins }),
  };
}
