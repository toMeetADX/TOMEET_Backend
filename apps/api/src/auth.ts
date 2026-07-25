import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

export type AccessTokenVerifier = (accessToken: string) => Promise<string>;
export type EmailAccessTokenMatcher = (accessToken: string) => Promise<boolean>;

export function createSupabaseAccessTokenVerifier(
  supabaseUrl: string,
  serviceRoleKey: string
): AccessTokenVerifier {
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return async (accessToken: string) => {
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data.user) throw new AuthenticationError("登录状态无效或已过期");
    return data.user.id;
  };
}

export function createSupabaseEmailAccessTokenMatcher(
  supabaseUrl: string,
  serviceRoleKey: string,
  allowedEmail: string
): EmailAccessTokenMatcher {
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const normalizedAllowedEmail = allowedEmail.trim().toLowerCase();
  let cachedTokenHash: string | null = null;
  let cacheExpiresAt = 0;

  return async (accessToken: string) => {
    const tokenHash = createHash("sha256").update(accessToken).digest("hex");
    if (tokenHash === cachedTokenHash && Date.now() < cacheExpiresAt) {
      return true;
    }
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data.user?.email) return false;
    const matches = data.user.email.trim().toLowerCase() === normalizedAllowedEmail;
    if (matches) {
      cachedTokenHash = tokenHash;
      cacheExpiresAt = Date.now() + 30_000;
    }
    return matches;
  };
}
