import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultRegistry } from "./circuit-breaker";
import { getOAuthToken, saveOAuthToken } from "./db";
import {
  ensureFreshToken,
  getLinearAccessToken,
  hasLinearAuth,
} from "./linear-auth";

// ---------------------------------------------------------------------------
// In-memory DB setup shared across tests
// ---------------------------------------------------------------------------

const OAUTH_TOKENS_DDL = `
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    service TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    token_type TEXT NOT NULL DEFAULT 'Bearer',
    scope TEXT,
    actor TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )
`;

function openTestDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.exec(OAUTH_TOKENS_DDL);
  return db;
}

function makeFreshToken(
  accessToken = "fresh-access-token",
  refreshToken = "refresh-token",
): Parameters<typeof saveOAuthToken>[2] {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    tokenType: "Bearer",
    scope: "read write",
    actor: "application",
  };
}

function makeExpiredToken(
  accessToken = "expired-access-token",
  refreshToken = "old-refresh-token",
): Parameters<typeof saveOAuthToken>[2] {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() - 1000, // already expired
    tokenType: "Bearer",
    scope: "read write",
    actor: "application",
  };
}

// ---------------------------------------------------------------------------
// getLinearAccessToken
// ---------------------------------------------------------------------------

describe("getLinearAccessToken", () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
    delete process.env.LINEAR_API_KEY;
  });

  test("returns OAuth access token from DB when present", async () => {
    await saveOAuthToken(db, "linear", makeFreshToken("my-oauth-token"));
    const token = getLinearAccessToken(db);
    expect(token).toBe("my-oauth-token");
  });

  test("falls back to LINEAR_API_KEY when no OAuth token in DB", () => {
    process.env.LINEAR_API_KEY = "lin_api_123";
    const token = getLinearAccessToken(db);
    expect(token).toBe("lin_api_123");
  });

  test("falls back to LINEAR_API_KEY when no DB provided", () => {
    process.env.LINEAR_API_KEY = "lin_api_456";
    const token = getLinearAccessToken();
    expect(token).toBe("lin_api_456");
  });

  test("throws when no DB and no LINEAR_API_KEY", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => getLinearAccessToken()).toThrow(
      "No Linear authentication configured",
    );
  });

  test("throws when DB has no token and no LINEAR_API_KEY", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => getLinearAccessToken(db)).toThrow(
      "No Linear authentication configured",
    );
  });

  test("falls back to LINEAR_API_KEY when OAuth token is expired", async () => {
    process.env.LINEAR_API_KEY = "lin_api_fallback";
    await saveOAuthToken(db, "linear", {
      ...makeFreshToken("expired-tok"),
      expiresAt: Date.now() - 1000, // already expired
    });
    const token = getLinearAccessToken(db);
    expect(token).toBe("lin_api_fallback");
  });

  test("falls back to LINEAR_API_KEY when OAuth token expires within 60s", async () => {
    process.env.LINEAR_API_KEY = "lin_api_fallback";
    await saveOAuthToken(db, "linear", {
      ...makeFreshToken("soon-expired-tok"),
      expiresAt: Date.now() + 30_000, // expires in 30s, within 60s buffer
    });
    const token = getLinearAccessToken(db);
    expect(token).toBe("lin_api_fallback");
  });

  test("throws clear error with actionable instructions when no auth configured", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => getLinearAccessToken()).toThrow("/auth/linear");
    expect(() => getLinearAccessToken()).toThrow("LINEAR_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// ensureFreshToken
// ---------------------------------------------------------------------------

// Mock refreshAccessToken so tests don't make real HTTP calls
const mockRefreshResponse = {
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 3600,
  token_type: "Bearer",
  scope: "read write",
};

const mockRefreshFn = mock(async () => mockRefreshResponse);

// We need to mock the module-level import in linear-auth.ts.
// Use Bun's module mock to intercept refreshAccessToken calls.
mock.module("./linear-oauth", () => ({
  refreshAccessToken: mockRefreshFn,
}));

describe("ensureFreshToken", () => {
  let db: Database;
  const oauthConfig = {
    clientId: "test-client-id",
    clientSecret: "test-secret",
  };

  beforeEach(() => {
    db = openTestDb();
    mockRefreshFn.mockClear();
    defaultRegistry.reset();
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    db.close();
    delete process.env.LINEAR_API_KEY;
  });

  test("returns existing access token when not expired", async () => {
    await saveOAuthToken(db, "linear", makeFreshToken("still-valid-token"));
    const token = await ensureFreshToken(db, oauthConfig);
    expect(token).toBe("still-valid-token");
    expect(mockRefreshFn).not.toHaveBeenCalled();
  });

  test("refreshes token when expired and persists new token to DB", async () => {
    await saveOAuthToken(db, "linear", makeExpiredToken());
    const token = await ensureFreshToken(db, oauthConfig);
    expect(token).toBe("new-access-token");
    expect(mockRefreshFn).toHaveBeenCalledTimes(1);
    // Verify new token was persisted
    const stored = getOAuthToken(db, "linear");
    expect(stored?.accessToken).toBe("new-access-token");
    expect(stored?.refreshToken).toBe("new-refresh-token");
  });

  test("refreshes token within 5-minute buffer window", async () => {
    // Token expires in 4 minutes — within the 5-minute buffer
    await saveOAuthToken(db, "linear", {
      ...makeFreshToken(),
      expiresAt: Date.now() + 4 * 60 * 1000,
    });
    const token = await ensureFreshToken(db, oauthConfig);
    expect(token).toBe("new-access-token");
    expect(mockRefreshFn).toHaveBeenCalledTimes(1);
  });

  test("does not refresh when token expires after 5-minute buffer", async () => {
    // Token expires in 6 minutes — outside the buffer
    await saveOAuthToken(db, "linear", {
      ...makeFreshToken("still-good"),
      expiresAt: Date.now() + 6 * 60 * 1000,
    });
    const token = await ensureFreshToken(db, oauthConfig);
    expect(token).toBe("still-good");
    expect(mockRefreshFn).not.toHaveBeenCalled();
  });

  test("falls back to LINEAR_API_KEY when no OAuth token in DB", async () => {
    process.env.LINEAR_API_KEY = "lin_api_fallback";
    const token = await ensureFreshToken(db, oauthConfig);
    expect(token).toBe("lin_api_fallback");
    expect(mockRefreshFn).not.toHaveBeenCalled();
  });

  test("throws when no OAuth token in DB and no LINEAR_API_KEY", async () => {
    delete process.env.LINEAR_API_KEY;
    await expect(ensureFreshToken(db, oauthConfig)).rejects.toThrow(
      "No Linear authentication configured",
    );
  });

  test("passes correct refresh credentials to refreshAccessToken", async () => {
    await saveOAuthToken(
      db,
      "linear",
      makeExpiredToken("old", "my-refresh-token"),
    );
    await ensureFreshToken(db, oauthConfig);
    expect(mockRefreshFn).toHaveBeenCalledWith({
      refreshToken: "my-refresh-token",
      clientId: "test-client-id",
      clientSecret: "test-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// hasLinearAuth
// ---------------------------------------------------------------------------

describe("hasLinearAuth", () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDb();
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    db.close();
    delete process.env.LINEAR_API_KEY;
  });

  test("returns true when LINEAR_API_KEY is set and no DB", () => {
    process.env.LINEAR_API_KEY = "lin_api_key";
    expect(hasLinearAuth()).toBe(true);
  });

  test("returns false when no LINEAR_API_KEY and no DB", () => {
    expect(hasLinearAuth()).toBe(false);
  });

  test("returns true when valid OAuth token is in DB", async () => {
    await saveOAuthToken(db, "linear", makeFreshToken());
    expect(hasLinearAuth(db)).toBe(true);
  });

  test("returns false when OAuth token is expired and no LINEAR_API_KEY", async () => {
    await saveOAuthToken(db, "linear", makeExpiredToken());
    expect(hasLinearAuth(db)).toBe(false);
  });

  test("returns true when OAuth token is expired but LINEAR_API_KEY is set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_key";
    await saveOAuthToken(db, "linear", makeExpiredToken());
    expect(hasLinearAuth(db)).toBe(true);
  });

  test("returns false when DB is empty and no LINEAR_API_KEY", () => {
    expect(hasLinearAuth(db)).toBe(false);
  });

  test("returns true when both valid OAuth token and LINEAR_API_KEY are set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_key";
    await saveOAuthToken(db, "linear", makeFreshToken());
    expect(hasLinearAuth(db)).toBe(true);
  });
});
