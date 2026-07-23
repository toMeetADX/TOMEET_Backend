import { createClient } from "@supabase/supabase-js";

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

export type AccessTokenVerifier = (accessToken: string) => Promise<string>;

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
