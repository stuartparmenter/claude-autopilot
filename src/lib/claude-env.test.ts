import { describe, expect, test } from "bun:test";
import { buildAgentEnv } from "./claude";

describe("buildAgentEnv", () => {
  test("sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", () => {
    const env = buildAgentEnv();
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  test("forwards allowlisted vars from process.env", () => {
    const env = buildAgentEnv();
    // HOME and PATH should always be present in the test environment
    expect(env.HOME).toBe(String(process.env.HOME));
    expect(env.PATH).toBe(String(process.env.PATH));
  });

  test("blocks system git config but preserves global", () => {
    const env = buildAgentEnv();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    // GIT_CONFIG_GLOBAL is NOT set — global config may contain
    // essential settings like core.sshCommand for SSH push.
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  test("does not include non-allowlisted process.env vars", () => {
    const env = buildAgentEnv();
    // These common env vars should NOT be forwarded
    expect(env.TERM).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
    expect(env.LANG).toBeUndefined();
  });

  test("only includes allowlisted keys plus teams flag", () => {
    const env = buildAgentEnv();
    const keys = Object.keys(env);
    const allowed = new Set([
      "HOME",
      "PATH",
      "SSH_AUTH_SOCK",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
      "GIT_CONFIG_NOSYSTEM",
    ]);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});
