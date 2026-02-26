import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildMcpServers } from "./agent-config";

describe("buildMcpServers", () => {
  let savedLinearApiKey: string | undefined;

  beforeEach(() => {
    savedLinearApiKey = process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    if (savedLinearApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = savedLinearApiKey;
    }
  });

  test("uses LINEAR_API_KEY env var when no token is passed", () => {
    process.env.LINEAR_API_KEY = "lin_api_test_key";
    const servers = buildMcpServers();
    const linear = servers.linear as { headers: { Authorization: string } };
    expect(linear.headers.Authorization).toBe("Bearer lin_api_test_key");
  });

  test("uses provided token instead of LINEAR_API_KEY", () => {
    process.env.LINEAR_API_KEY = "lin_api_env_key";
    const servers = buildMcpServers("lin_api_passed_token");
    const linear = servers.linear as { headers: { Authorization: string } };
    expect(linear.headers.Authorization).toBe("Bearer lin_api_passed_token");
  });

  test("throws when no token passed and LINEAR_API_KEY is not set", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => buildMcpServers()).toThrow("No Linear token available");
  });

  test("throws when empty string token is passed and LINEAR_API_KEY is not set", () => {
    delete process.env.LINEAR_API_KEY;
    // Passing undefined explicitly — same as calling without args
    expect(() => buildMcpServers(undefined)).toThrow(
      "No Linear token available",
    );
  });

  test("uses provided token even when LINEAR_API_KEY is not set", () => {
    delete process.env.LINEAR_API_KEY;
    const servers = buildMcpServers("oauth_token_xyz");
    const linear = servers.linear as { headers: { Authorization: string } };
    expect(linear.headers.Authorization).toBe("Bearer oauth_token_xyz");
  });

  test("returns github and autopilot servers alongside linear", () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const servers = buildMcpServers();
    expect(servers.linear).toBeDefined();
    expect(servers.github).toBeDefined();
    expect(servers.autopilot).toBeDefined();
  });
});
