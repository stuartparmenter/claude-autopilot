import type { Database } from "bun:sqlite";
import { info, warn } from "./logger";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix ms
}

// Module-level cached state
let _cachedToken: string | null = null;
let _expiresAt = 0;
let _refreshToken: string | null = null;
let _refreshing = false;
let _dbRef: Database | null = null;

/**
 * Initialize Linear auth from DB. Loads stored OAuth token and refreshes if expired.
 * Call this once at startup before any Linear API calls.
 */
export async function initLinearAuth(db: Database): Promise<void> {
  _dbRef = db;
  const token = getStoredToken(db);
  if (!token) return;

  _refreshToken = token.refreshToken ?? null;

  if (Date.now() >= token.expiresAt) {
    // Token already expired — try to refresh immediately
    if (_refreshToken) {
      await tryRefresh(db);
    }
    return;
  }

  _cachedToken = token.accessToken;
  _expiresAt = token.expiresAt;
}

/**
 * Get the current Linear access token.
 * Returns OAuth token if configured and valid, otherwise falls back to LINEAR_API_KEY.
 * Schedules a background refresh if the token is approaching expiry (< 1h remaining).
 */
export function getCurrentLinearToken(): string | null {
  if (_cachedToken) {
    const now = Date.now();
    // Proactively refresh when < 1 hour remaining (fire-and-forget)
    if (
      !_refreshing &&
      _refreshToken &&
      _dbRef &&
      now >= _expiresAt - 60 * 60 * 1000
    ) {
      _refreshing = true;
      const db = _dbRef;
      tryRefresh(db).finally(() => {
        _refreshing = false;
      });
    }
    // Return current token if still valid
    if (now < _expiresAt) {
      return _cachedToken;
    }
  }

  // Fall back to personal API key env var
  return process.env.LINEAR_API_KEY ?? null;
}

async function tryRefresh(db: Database): Promise<void> {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret || !_refreshToken) return;

  try {
    const token = await refreshOAuthToken(
      clientId,
      clientSecret,
      _refreshToken,
    );
    saveStoredToken(db, token);
    info("Linear OAuth token refreshed successfully");
  } catch (e) {
    warn(`Failed to refresh Linear OAuth token: ${e}`);
  }
}

/**
 * Exchange an OAuth authorization code for an access token.
 */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OAuthToken> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Linear OAuth token exchange failed (${res.status}): ${text}`,
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 86400) * 1000,
  };
}

/**
 * Refresh an expired OAuth access token using the refresh token.
 */
export async function refreshOAuthToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthToken> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Linear OAuth token refresh failed (${res.status}): ${text}`,
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 86400) * 1000,
  };
}

/**
 * Build the Linear OAuth authorization URL with actor=app.
 */
export function buildOAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    actor: "app",
    scope: "read,write,issues:create,comments:create",
  });
  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

// --- DB helpers ---

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
}

function getStoredToken(db: Database): OAuthToken | null {
  try {
    const row = db
      .query<OAuthTokenRow, []>(
        `SELECT access_token, refresh_token, expires_at FROM linear_oauth_tokens WHERE id = 1`,
      )
      .get();
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      expiresAt: row.expires_at,
    };
  } catch {
    // Table may not exist in older DBs opened before schema migration
    return null;
  }
}

/**
 * Persist an OAuth token to the DB and update the in-memory cache.
 */
export function saveStoredToken(db: Database, token: OAuthToken): void {
  db.run(
    `INSERT OR REPLACE INTO linear_oauth_tokens
     (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
    [
      token.accessToken,
      token.refreshToken ?? null,
      token.expiresAt,
      Date.now(),
    ],
  );
  // Update in-memory cache
  _cachedToken = token.accessToken;
  _expiresAt = token.expiresAt;
  _refreshToken = token.refreshToken ?? null;
  _dbRef = db;
}

/**
 * Reset all cached OAuth state. Used in tests.
 */
export function resetLinearAuth(): void {
  _cachedToken = null;
  _expiresAt = 0;
  _refreshToken = null;
  _refreshing = false;
  _dbRef = null;
}
