import { resolve } from "node:path";
import {
  type AgentDefinition,
  createSdkMcpServer,
  type SdkPluginConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SandboxConfig } from "./config";
import { enableAutoMerge } from "./github";
import { createProjectStatusUpdate } from "./linear";

/** Domains agents always need access to when network is restricted. */
export const SANDBOX_BASE_DOMAINS = [
  "github.com",
  "api.github.com",
  "api.githubcopilot.com",
  "mcp.linear.app",
];

export const AGENT_ENV_ALLOWLIST: readonly string[] = [
  // System basics
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LANG",
  "LOGNAME",
  "HOSTNAME",
  // Agent SDK auth
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  // Bedrock auth
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  // Vertex auth
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  // Auth mode flags
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Git/SSH
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  // Temp directories
  "TMPDIR",
  "TMP",
  "TEMP",
  // XDG
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // Proxy/TLS (corporate environments)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
] as const;

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

export function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  return env;
}

export function buildSandboxConfig(
  cwd: string,
  sandbox: SandboxConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    enabled: true,
    autoAllowBashIfSandboxed: sandbox.auto_allow_bash ?? true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [
        // Git worktrees share the parent repo's .git directory
        resolve(cwd, ".git"),
        // Allow /tmp for Claude Code internals, git, bun, ssh-keygen, etc.
        // Per-agent TMPDIR scoping is blocked by SDK overriding env vars:
        // https://github.com/anthropics/claude-code/issues/15700
        "/tmp",
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
 * Build the base query options object for the Agent SDK.
 * Does not include sandbox config (added conditionally) or worktree cwd override.
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
