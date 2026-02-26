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

/**
 * Build env overrides for agent subprocesses.
 * Intentionally tight — only vars the SDK won't have from natural
 * process.env inheritance. TMPDIR overrides for sandbox isolation
 * are layered on top in runClaude() when sandbox is enabled.
 */
export function buildAgentEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };
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
