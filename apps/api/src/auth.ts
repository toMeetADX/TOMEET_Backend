import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

export type AccessTokenVerifier = (accessToken: string) => Promise<string>;
export type EmailAccessTokenMatcher = (accessToken: string) => Promise<boolean>;

export interface ProvisionedWechatWebAccount {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionExpiresAt: string;
}

export interface WechatWebAccountProvisioner {
  provision(): Promise<ProvisionedWechatWebAccount>;
  discard(userId: string): Promise<void>;
}

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

export function createSupabaseWechatWebAccountProvisioner(
  supabaseUrl: string,
  serviceRoleKey: string
): WechatWebAccountProvisioner {
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return {
    async provision() {
      // Use a fresh client for every anonymous sign-up. Auth clients keep their
      // current session in memory even when persistence is disabled, so sharing
      // one client across concurrent QR activations could cross-contaminate them.
      const client = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      });
      const { data, error } = await client.auth.signInAnonymously({
        options: {
          data: {
            registration_status: "pending",
            registration_source: "wechat"
          }
        }
      });
      if (error || !data.user || !data.session) {
        throw new AuthenticationError(
          error?.message ?? "无法初始化微信 Web 注册账号"
        );
      }
      const expiresAtSeconds = data.session.expires_at;
      if (!expiresAtSeconds) {
        await adminClient.auth.admin.deleteUser(data.user.id).catch(() => undefined);
        throw new AuthenticationError("Supabase 匿名会话缺少有效期");
      }
      return {
        userId: data.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        sessionExpiresAt: new Date(expiresAtSeconds * 1000).toISOString()
      };
    },

    async discard(userId) {
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) throw new Error(`清理未使用的微信 Web 账号失败: ${error.message}`);
    }
  };
}
