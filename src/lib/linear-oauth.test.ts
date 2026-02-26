import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { openDb } from "./db";
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  getCurrentLinearToken,
  initLinearAuth,
  refreshOAuthToken,
  resetLinearAuth,
  saveStoredToken,
} from "./linear-oauth";

// ---------------------------------------------------------------------------
// buildOAuthUrl
// ---------------------------------------------------------------------------

describe("buildOAuthUrl", () => {
  test("builds correct URL with required parameters", () => {
    const url = buildOAuthUrl("my-client-id", "https://example.com/callback");
    expect(url).toContain("https://linear.app/oauth/authorize");
    expect(url).toContain("client_id=my-client-id");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcallback");
    expect(url).toContain("response_type=code");
    expect(url).toContain("actor=app");
  });

  test("includes required OAuth scopes", () => {
    const url = buildOAuthUrl("cid", "https://example.com/cb");
    expect(url).toContain("scope=");
    expect(url).toContain("read");
    expect(url).toContain("write");
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForToken / refreshOAuthToken — fetch mocking
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  body: string;
}

let fetchCalls: FetchCall[] = [];
let fetchResponses: Array<{
  ok: boolean;
  status: number;
  json?: object;
  text?: string;
}> = [];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  globalThis.fetch = mock(async (url: string, opts: { body?: string } = {}) => {
    fetchCalls.push({ url: String(url), body: opts.body ?? "" });
    const resp = fetchResponses.shift();
    if (!resp) throw new Error("Unexpected fetch call");
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.json,
      text: async () => resp.text ?? JSON.stringify(resp.json),
    } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLinearAuth();
  delete process.env.LINEAR_CLIENT_ID;
  delete process.env.LINEAR_CLIENT_SECRET;
  delete process.env.LINEAR_API_KEY;
});

describe("exchangeCodeForToken", () => {
  test("sends correct POST parameters and returns parsed token", async () => {
    const expiresIn = 86400;
    fetchResponses.push({
      ok: true,
      status: 200,
      json: {
        access_token: "access-tok",
        refresh_token: "refresh-tok",
        expires_in: expiresIn,
      },
    });

    const beforeCall = Date.now();
    const token = await exchangeCodeForToken(
      "cid",
      "csecret",
      "auth-code",
      "https://example.com/cb",
    );
    const afterCall = Date.now();

    expect(token.accessToken).toBe("access-tok");
    expect(token.refreshToken).toBe("refresh-tok");
    expect(token.expiresAt).toBeGreaterThanOrEqual(
      beforeCall + expiresIn * 1000,
    );
    expect(token.expiresAt).toBeLessThanOrEqual(afterCall + expiresIn * 1000);

    const body = new URLSearchParams(fetchCalls[0].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("redirect_uri")).toBe("https://example.com/cb");
  });

  test("handles missing refresh_token in response", async () => {
    fetchResponses.push({
      ok: true,
      status: 200,
      json: { access_token: "access-only", expires_in: 3600 },
    });

    const token = await exchangeCodeForToken("cid", "csecret", "code", "uri");
    expect(token.refreshToken).toBeUndefined();
  });

  test("defaults expires_at to 24h when expires_in is absent", async () => {
    fetchResponses.push({
      ok: true,
      status: 200,
      json: { access_token: "tok" },
    });

    const before = Date.now();
    const token = await exchangeCodeForToken("cid", "csecret", "code", "uri");
    const after = Date.now();

    const expected24h = 86400 * 1000;
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + expected24h);
    expect(token.expiresAt).toBeLessThanOrEqual(after + expected24h);
  });

  test("throws on non-OK response with status and body", async () => {
    fetchResponses.push({
      ok: false,
      status: 400,
      text: "invalid_grant",
    });

    await expect(
      exchangeCodeForToken("cid", "csecret", "bad-code", "uri"),
    ).rejects.toThrow("400");
  });
});

describe("refreshOAuthToken", () => {
  test("sends correct refresh_token grant parameters", async () => {
    fetchResponses.push({
      ok: true,
      status: 200,
      json: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
      },
    });

    const token = await refreshOAuthToken("cid", "csecret", "old-refresh");

    expect(token.accessToken).toBe("new-access");
    expect(token.refreshToken).toBe("new-refresh");

    const body = new URLSearchParams(fetchCalls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
  });

  test("throws on non-OK response", async () => {
    fetchResponses.push({ ok: false, status: 401, text: "invalid_token" });

    await expect(
      refreshOAuthToken("cid", "csecret", "bad-refresh"),
    ).rejects.toThrow("401");
  });
});

// ---------------------------------------------------------------------------
// saveStoredToken / getCurrentLinearToken / initLinearAuth
// ---------------------------------------------------------------------------

describe("saveStoredToken + getCurrentLinearToken", () => {
  test("returns saved access token when not expired", () => {
    const db = openDb(":memory:");
    const expiresAt = Date.now() + 3600 * 1000;
    saveStoredToken(db, { accessToken: "oauth-tok", expiresAt });

    expect(getCurrentLinearToken()).toBe("oauth-tok");
  });

  test("returns null after token expires (no refresh token)", () => {
    const db = openDb(":memory:");
    saveStoredToken(db, {
      accessToken: "expired-tok",
      expiresAt: Date.now() - 1000,
    });

    // No API key fallback
    delete process.env.LINEAR_API_KEY;
    expect(getCurrentLinearToken()).toBeNull();
  });

  test("falls back to LINEAR_API_KEY when no OAuth token", () => {
    process.env.LINEAR_API_KEY = "lin_api_fallback";
    expect(getCurrentLinearToken()).toBe("lin_api_fallback");
  });

  test("prefers OAuth token over LINEAR_API_KEY", () => {
    process.env.LINEAR_API_KEY = "lin_api_should_not_use";
    const db = openDb(":memory:");
    saveStoredToken(db, {
      accessToken: "oauth-preferred",
      expiresAt: Date.now() + 3600 * 1000,
    });

    expect(getCurrentLinearToken()).toBe("oauth-preferred");
  });

  test("returns null when neither OAuth nor API key is configured", () => {
    delete process.env.LINEAR_API_KEY;
    expect(getCurrentLinearToken()).toBeNull();
  });
});

describe("initLinearAuth", () => {
  test("loads valid token from DB into memory", async () => {
    const db = openDb(":memory:");
    const expiresAt = Date.now() + 7200 * 1000;
    db.run(
      `INSERT OR REPLACE INTO linear_oauth_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?)`,
      ["stored-tok", "refresh-tok", expiresAt, Date.now()],
    );

    await initLinearAuth(db);

    expect(getCurrentLinearToken()).toBe("stored-tok");
  });

  test("returns without error when no token is stored", async () => {
    const db = openDb(":memory:");
    await initLinearAuth(db);
    // No OAuth token, no API key → null
    delete process.env.LINEAR_API_KEY;
    expect(getCurrentLinearToken()).toBeNull();
  });

  test("attempts refresh when stored token is expired", async () => {
    process.env.LINEAR_CLIENT_ID = "cid";
    process.env.LINEAR_CLIENT_SECRET = "csecret";

    const db = openDb(":memory:");
    const expiredAt = Date.now() - 1000;
    db.run(
      `INSERT OR REPLACE INTO linear_oauth_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?)`,
      ["old-tok", "old-refresh", expiredAt, Date.now()],
    );

    fetchResponses.push({
      ok: true,
      status: 200,
      json: {
        access_token: "refreshed-tok",
        refresh_token: "new-refresh",
        expires_in: 86400,
      },
    });

    await initLinearAuth(db);

    expect(getCurrentLinearToken()).toBe("refreshed-tok");
    // Verify refresh grant was sent
    const body = new URLSearchParams(fetchCalls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  test("falls back to API key when expired token has no refresh_token", async () => {
    process.env.LINEAR_API_KEY = "lin_api_fallback";

    const db = openDb(":memory:");
    db.run(
      `INSERT OR REPLACE INTO linear_oauth_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?)`,
      ["old-tok", null, Date.now() - 1000, Date.now()],
    );

    await initLinearAuth(db);

    // No fetch should have happened (no refresh token)
    expect(fetchCalls).toHaveLength(0);
    // Falls back to API key
    expect(getCurrentLinearToken()).toBe("lin_api_fallback");
  });
});
