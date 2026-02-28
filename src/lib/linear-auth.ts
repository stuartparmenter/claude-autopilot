/**
 * linear-auth.ts — Token resolution and proactive refresh for Linear OAuth.
 *
 * Provides two functions:
 * - getLinearAccessToken(): synchronous, returns current token (no refresh)
 * - ensureFreshToken(): async, proactively refreshes if expiry is near
 */

import type { Database } from "bun:sqlite";
import type { OAuthTokenRow } from "./db";
import { getOAuthToken, saveOAuthToken } from "./db";
import { refreshAccessToken } from "./linear-oauth";
import { info, ok } from "./logger";
import { withRetry } from "./retry";

/** Refresh the token this many ms before actual expiry to avoid races. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Return the current Linear access token without attempting a refresh.
 * Checks the SQLite DB for a stored OAuth token first; falls back to
 * the LINEAR_API_KEY environment variable.
 *
 * If the OAuth token exists but is expired, falls through to LINEAR_API_KEY.
 * Expired token refresh is handled by ensureFreshToken().
 */
export function getLinearAccessToken(db?: Database): string {
  if (db) {
    const token = getOAuthToken(db, "linear");
    if (token && token.expiresAt > Date.now() + 60_000) {
      return token.accessToken;
    }
    // Token missing or expired — fall through to LINEAR_API_KEY
  }
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Linear authentication configured.\n" +
        "Either complete OAuth setup at /auth/linear or set LINEAR_API_KEY.\n" +
        "Create an API key at: https://linear.app/settings/api",
    );
  }
  return apiKey;
}

/**
 * Returns true if any Linear auth method is available (valid OAuth token or LINEAR_API_KEY).
 */
export function hasLinearAuth(db?: Database): boolean {
  if (db) {
    const token = getOAuthToken(db, "linear");
    if (token && token.expiresAt > Date.now() + 60_000) return true;
  }
  return !!process.env.LINEAR_API_KEY;
}

/**
 * Return a fresh Linear access token, proactively refreshing if the stored
 * OAuth token is within REFRESH_BUFFER_MS of expiry.
 *
 * Falls back to LINEAR_API_KEY if no OAuth token is stored in the DB.
 */
export async function ensureFreshToken(
  db: Database,
  oauthConfig: { clientId: string; clientSecret: string },
): Promise<string> {
  const token = getOAuthToken(db, "linear");
  if (!token) {
    // No OAuth token in DB — fall back to LINEAR_API_KEY
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No Linear authentication configured.\n" +
          "Option 1: Set LINEAR_API_KEY (https://linear.app/settings/api)\n" +
          "Option 2: Configure linear.oauth and complete the OAuth flow at /auth/linear",
      );
    }
    return apiKey;
  }

  // Token is still fresh — return it as-is
  if (token.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return token.accessToken;
  }

  // Token is about to expire (or already expired) — refresh it
  info("Refreshing Linear OAuth token...");
  const refreshed = await withRetry(
    () =>
      refreshAccessToken({
        refreshToken: token.refreshToken,
        clientId: oauthConfig.clientId,
        clientSecret: oauthConfig.clientSecret,
      }),
    "ensureFreshToken",
  );

  const newToken: OAuthTokenRow = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    tokenType: refreshed.token_type,
    scope: refreshed.scope,
    actor: "application",
  };
  await saveOAuthToken(db, "linear", newToken);
  ok("Linear OAuth token refreshed");

  return newToken.accessToken;
}
