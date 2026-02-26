import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentEnv } from "./claude";

describe("buildAgentEnv", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env to original state
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  test("passes through safe system vars", () => {
    process.env.HOME = "/home/testuser";
    process.env.PATH = "/usr/bin:/bin";

    const env = buildAgentEnv();

    expect(env.HOME).toBe("/home/testuser");
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("excludes secret vars", () => {
    process.env.LINEAR_API_KEY = "lin_secret_123";
    process.env.GITHUB_TOKEN = "ghp_secret_456";
    process.env.AUTOPILOT_DASHBOARD_TOKEN = "tok_secret_789";

    const env = buildAgentEnv();

    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AUTOPILOT_DASHBOARD_TOKEN).toBeUndefined();
  });

  test("always sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to 1", () => {
    const env = buildAgentEnv();

    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  test("excludes undefined vars", () => {
    delete process.env.AWS_REGION;

    const env = buildAgentEnv();

    expect(env.AWS_REGION).toBeUndefined();
  });

  test("passes through Bedrock and Vertex auth vars", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const env = buildAgentEnv();

    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  test("passes through proxy vars", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";

    const env = buildAgentEnv();

    expect(env.HTTPS_PROXY).toBe("http://proxy.example.com:8080");
  });

  test("returns Record<string, string> with only string values", () => {
    const env = buildAgentEnv();

    for (const [, value] of Object.entries(env)) {
      expect(typeof value).toBe("string");
    }
  });
});
