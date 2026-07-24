import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ActivateWechatSessionInput,
  CreateWechatSessionInput,
  WechatConnection,
  WechatConnectionSession,
  WechatSessionUpdate
} from "@tomeet/wechat-ilink";
import { StoreConflictError, StoreNotFoundError } from "./store.js";
import type { WechatConnectionStore } from "./wechat-store.js";

type JsonRow = Record<string, unknown>;

function unwrapRpcData(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) return data[0];
  return data;
}

function mapSession(row: JsonRow): WechatConnectionSession {
  return {
    id: String(row.id),
    sessionTokenHash: String(row.session_token_hash ?? row.sessionTokenHash),
    qrTokenCiphertext: String(row.qr_token_ciphertext ?? row.qrTokenCiphertext),
    status: row.status as WechatConnectionSession["status"],
    pollBaseUrl: String(row.poll_base_url ?? row.pollBaseUrl),
    requestedUserId: (row.requested_user_id ?? row.requestedUserId ?? null) as string | null,
    connectionId: (row.connection_id ?? row.connectionId ?? null) as string | null,
    userId: (row.user_id ?? row.userId ?? null) as string | null,
    expiresAt: String(row.expires_at ?? row.expiresAt),
    confirmedAt: (row.confirmed_at ?? row.confirmedAt ?? null) as string | null,
    errorCode: (row.error_code ?? row.errorCode ?? null) as string | null,
    errorMessage: (row.error_message ?? row.errorMessage ?? null) as string | null,
    createdAt: String(row.created_at ?? row.createdAt),
    updatedAt: String(row.updated_at ?? row.updatedAt)
  };
}

function mapConnection(row: JsonRow): WechatConnection {
  return {
    id: String(row.id),
    userId: String(row.user_id ?? row.userId),
    ilinkBotId: String(row.ilink_bot_id ?? row.ilinkBotId),
    ownerIlinkUserId: String(row.owner_ilink_user_id ?? row.ownerIlinkUserId),
    botTokenCiphertext: String(row.bot_token_ciphertext ?? row.botTokenCiphertext),
    baseUrl: String(row.base_url ?? row.baseUrl),
    syncCursor: String(row.sync_cursor ?? row.syncCursor ?? ""),
    status: row.status as WechatConnection["status"],
    leaseOwner: (row.lease_owner ?? row.leaseOwner ?? null) as string | null,
    leaseExpiresAt: (row.lease_expires_at ?? row.leaseExpiresAt ?? null) as string | null,
    lastMessageAt: (row.last_message_at ?? row.lastMessageAt ?? null) as string | null,
    lastError: (row.last_error ?? row.lastError ?? null) as string | null,
    failureCount: Number(row.failure_count ?? row.failureCount ?? 0),
    createdAt: String(row.created_at ?? row.createdAt),
    updatedAt: String(row.updated_at ?? row.updatedAt)
  };
}

export class SupabaseWechatStore implements WechatConnectionStore {
  constructor(private readonly client: SupabaseClient) {}

  private throwError(context: string, error: { message: string; code?: string } | null): never {
    if (error?.code === "P0002") throw new StoreNotFoundError(error.message);
    if (error?.code === "23505" || error?.code === "P0001" || error?.code === "40001") {
      throw new StoreConflictError(error.message);
    }
    throw new Error(`${context}: ${error?.message ?? "Supabase request failed"}`);
  }

  async createWechatSession(
    input: CreateWechatSessionInput
  ): Promise<WechatConnectionSession> {
    const { data, error } = await this.client
      .from("wechat_connection_sessions")
      .insert({
        id: input.id,
        session_token_hash: input.sessionTokenHash,
        qr_token_ciphertext: input.qrTokenCiphertext,
        poll_base_url: input.pollBaseUrl,
        expires_at: input.expiresAt,
        requested_user_id: input.requestedUserId ?? null
      })
      .select("*")
      .single();
    if (error) this.throwError("Create WeChat session", error);
    return mapSession(data as JsonRow);
  }

  async getWechatSession(sessionId: string): Promise<WechatConnectionSession | null> {
    const { data, error } = await this.client
      .from("wechat_connection_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) this.throwError("Read WeChat session", error);
    return data ? mapSession(data as JsonRow) : null;
  }

  async updateWechatSession(
    sessionId: string,
    update: WechatSessionUpdate,
    options?: {
      ifStatusIn?: WechatConnectionSession["status"][];
    }
  ): Promise<WechatConnectionSession> {
    const values: JsonRow = { updated_at: new Date().toISOString() };
    if (update.status !== undefined) values.status = update.status;
    if (update.pollBaseUrl !== undefined) values.poll_base_url = update.pollBaseUrl;
    if (update.errorCode !== undefined) values.error_code = update.errorCode;
    if (update.errorMessage !== undefined) values.error_message = update.errorMessage;
    let query = this.client
      .from("wechat_connection_sessions")
      .update(values)
      .eq("id", sessionId);
    if (options?.ifStatusIn?.length) {
      query = query.in("status", options.ifStatusIn);
    }
    const { data, error } = await query.select("*").maybeSingle();
    if (error) this.throwError("Update WeChat session", error);
    if (!data) {
      const current = await this.getWechatSession(sessionId);
      if (!current) throw new StoreNotFoundError("微信扫码会话不存在");
      return current;
    }
    return mapSession(data as JsonRow);
  }

  async activateWechatSession(input: ActivateWechatSessionInput): Promise<{
    session: WechatConnectionSession;
    connection: WechatConnection;
  }> {
    const { data, error } = await this.client.rpc("activate_wechat_ilink_session", {
      p_session_id: input.sessionId,
      p_new_user_id: input.newUserId,
      p_owner_ilink_user_id: input.ownerIlinkUserId,
      p_ilink_bot_id: input.ilinkBotId,
      p_bot_token_ciphertext: input.botTokenCiphertext,
      p_base_url: input.baseUrl
    });
    if (error) this.throwError("Activate WeChat connection", error);
    const result = unwrapRpcData(data) as {
      session: JsonRow;
      connection: JsonRow;
    };
    return {
      session: mapSession(result.session),
      connection: mapConnection(result.connection)
    };
  }

  async claimWechatConnections(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<WechatConnection[]> {
    const { data, error } = await this.client.rpc("claim_wechat_ilink_connections", {
      p_worker_id: input.workerId,
      p_limit: input.limit,
      p_lease_seconds: input.leaseSeconds
    });
    if (error) this.throwError("Claim WeChat connections", error);
    return (data ?? []).map((row: unknown) => mapConnection(row as JsonRow));
  }

  async renewWechatConnectionLease(
    connectionId: string,
    workerId: string,
    leaseSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("wechat_ilink_connections")
      .update({
        lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", connectionId)
      .eq("lease_owner", workerId)
      .eq("status", "active")
      .select("id");
    if (error) this.throwError("Renew WeChat connection lease", error);
    return Boolean(data?.length);
  }

  async updateWechatConnectionCursor(
    connectionId: string,
    workerId: string,
    cursor: string,
    lastMessageAt?: string
  ): Promise<boolean> {
    const values: JsonRow = {
      sync_cursor: cursor,
      failure_count: 0,
      last_error: null,
      updated_at: new Date().toISOString()
    };
    if (lastMessageAt) values.last_message_at = lastMessageAt;
    const { data, error } = await this.client
      .from("wechat_ilink_connections")
      .update(values)
      .eq("id", connectionId)
      .eq("lease_owner", workerId)
      .select("id");
    if (error) this.throwError("Update WeChat cursor", error);
    return Boolean(data?.length);
  }

  async releaseWechatConnection(connectionId: string, workerId: string): Promise<void> {
    const { error } = await this.client
      .from("wechat_ilink_connections")
      .update({
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", connectionId)
      .eq("lease_owner", workerId);
    if (error) this.throwError("Release WeChat connection", error);
  }

  async markWechatConnectionError(input: {
    connectionId: string;
    workerId: string;
    message: string;
    reauthRequired: boolean;
  }): Promise<void> {
    const { error } = await this.client.rpc("fail_wechat_ilink_connection", {
      p_connection_id: input.connectionId,
      p_worker_id: input.workerId,
      p_error: input.message.slice(0, 1000),
      p_reauth_required: input.reauthRequired
    });
    if (error) this.throwError("Mark WeChat connection failure", error);
  }

  async beginWechatMessage(connectionId: string, messageId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc("begin_wechat_message", {
      p_connection_id: connectionId,
      p_message_id: messageId
    });
    if (error) this.throwError("Begin WeChat message", error);
    return data === true;
  }

  async completeWechatMessage(
    connectionId: string,
    messageId: string,
    errorMessage?: string
  ): Promise<void> {
    const { error } = await this.client
      .from("wechat_message_receipts")
      .update({
        status: errorMessage ? "failed" : "completed",
        error: errorMessage?.slice(0, 1000) ?? null,
        completed_at: errorMessage ? null : new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("connection_id", connectionId)
      .eq("message_id", messageId);
    if (error) this.throwError("Complete WeChat message", error);
  }
}
