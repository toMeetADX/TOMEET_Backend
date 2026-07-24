import { randomUUID } from "node:crypto";
import type {
  ActivateWechatSessionInput,
  CreateWechatSessionInput,
  WechatConnection,
  WechatConnectionSession,
  WechatSessionUpdate
} from "@tomeet/wechat-ilink";
import type { DataStore } from "./store.js";
import { StoreConflictError, StoreNotFoundError } from "./store.js";
import type { WechatConnectionStore } from "./wechat-store.js";

type ReceiptStatus = "processing" | "completed" | "failed";

export class MemoryWechatStore implements WechatConnectionStore {
  private readonly sessions = new Map<string, WechatConnectionSession>();
  private readonly connections = new Map<string, WechatConnection>();
  private readonly connectionByUser = new Map<string, string>();
  private readonly receipts = new Map<string, ReceiptStatus>();

  constructor(private readonly userStore: DataStore) {}

  async createWechatSession(
    input: CreateWechatSessionInput
  ): Promise<WechatConnectionSession> {
    if (this.sessions.has(input.id)) throw new StoreConflictError("微信扫码会话已存在");
    const now = new Date().toISOString();
    const session: WechatConnectionSession = {
      id: input.id,
      sessionTokenHash: input.sessionTokenHash,
      qrTokenCiphertext: input.qrTokenCiphertext,
      status: "pending",
      pollBaseUrl: input.pollBaseUrl,
      requestedUserId: input.requestedUserId ?? null,
      connectionId: null,
      userId: null,
      expiresAt: input.expiresAt,
      confirmedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async getWechatSession(sessionId: string): Promise<WechatConnectionSession | null> {
    return structuredClone(this.sessions.get(sessionId) ?? null);
  }

  async updateWechatSession(
    sessionId: string,
    update: WechatSessionUpdate,
    options?: {
      ifStatusIn?: WechatConnectionSession["status"][];
    }
  ): Promise<WechatConnectionSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new StoreNotFoundError("微信扫码会话不存在");
    if (
      options?.ifStatusIn
      && !options.ifStatusIn.includes(session.status)
    ) {
      return structuredClone(session);
    }
    Object.assign(session, update, { updatedAt: new Date().toISOString() });
    return structuredClone(session);
  }

  async activateWechatSession(input: ActivateWechatSessionInput): Promise<{
    session: WechatConnectionSession;
    connection: WechatConnection;
  }> {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new StoreNotFoundError("微信扫码会话不存在");
    if (session.status === "active" && session.connectionId) {
      const existing = this.connections.get(session.connectionId);
      if (!existing) throw new StoreNotFoundError("微信连接不存在");
      return { session: structuredClone(session), connection: structuredClone(existing) };
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      session.status = "expired";
      throw new StoreConflictError("微信二维码已过期");
    }

    const identity = await this.userStore.resolveChannelIdentity(
      "wechat",
      input.ownerIlinkUserId
    );
    if (
      identity
      && session.requestedUserId
      && identity.userId !== session.requestedUserId
    ) {
      throw new StoreConflictError("该微信已关联其他 TOMEET profile");
    }
    const userId = identity?.userId ?? session.requestedUserId ?? input.newUserId;
    await this.userStore.ensureUser(userId, "微信用户");
    if (!identity) {
      await this.userStore.linkChannelIdentity({
        provider: "wechat",
        externalUserId: input.ownerIlinkUserId,
        userId,
        displayName: "微信用户"
      });
    }

    const now = new Date().toISOString();
    const currentId = this.connectionByUser.get(userId);
    const connection: WechatConnection = currentId
      ? this.connections.get(currentId)!
      : {
          id: randomUUID(),
          userId,
          ilinkBotId: input.ilinkBotId,
          ownerIlinkUserId: input.ownerIlinkUserId,
          botTokenCiphertext: input.botTokenCiphertext,
          baseUrl: input.baseUrl,
          syncCursor: "",
          status: "active",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastMessageAt: null,
          lastError: null,
          failureCount: 0,
          createdAt: now,
          updatedAt: now
        };
    Object.assign(connection, {
      ilinkBotId: input.ilinkBotId,
      ownerIlinkUserId: input.ownerIlinkUserId,
      botTokenCiphertext: input.botTokenCiphertext,
      baseUrl: input.baseUrl,
      syncCursor: "",
      status: "active" as const,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      failureCount: 0,
      updatedAt: now
    });
    this.connections.set(connection.id, connection);
    this.connectionByUser.set(userId, connection.id);
    Object.assign(session, {
      status: "active" as const,
      connectionId: connection.id,
      userId,
      confirmedAt: now,
      errorCode: null,
      errorMessage: null,
      updatedAt: now
    });
    return {
      session: structuredClone(session),
      connection: structuredClone(connection)
    };
  }

  async claimWechatConnections(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<WechatConnection[]> {
    const now = Date.now();
    const claimed: WechatConnection[] = [];
    for (const connection of this.connections.values()) {
      if (
        claimed.length >= input.limit
        || connection.status !== "active"
        || (
          connection.leaseExpiresAt
          && new Date(connection.leaseExpiresAt).getTime() > now
          && connection.leaseOwner !== input.workerId
        )
      ) {
        continue;
      }
      connection.leaseOwner = input.workerId;
      connection.leaseExpiresAt = new Date(now + input.leaseSeconds * 1000).toISOString();
      connection.updatedAt = new Date().toISOString();
      claimed.push(structuredClone(connection));
    }
    return claimed;
  }

  async renewWechatConnectionLease(
    connectionId: string,
    workerId: string,
    leaseSeconds: number
  ): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.leaseOwner !== workerId || connection.status !== "active") {
      return false;
    }
    connection.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return true;
  }

  async updateWechatConnectionCursor(
    connectionId: string,
    workerId: string,
    cursor: string,
    lastMessageAt?: string
  ): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.leaseOwner !== workerId) return false;
    connection.syncCursor = cursor;
    connection.lastMessageAt = lastMessageAt ?? connection.lastMessageAt;
    connection.failureCount = 0;
    connection.lastError = null;
    connection.updatedAt = new Date().toISOString();
    return true;
  }

  async releaseWechatConnection(connectionId: string, workerId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection?.leaseOwner === workerId) {
      connection.leaseOwner = null;
      connection.leaseExpiresAt = null;
    }
  }

  async markWechatConnectionError(input: {
    connectionId: string;
    workerId: string;
    message: string;
    reauthRequired: boolean;
  }): Promise<void> {
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.leaseOwner !== input.workerId) return;
    connection.failureCount += 1;
    connection.lastError = input.message;
    connection.status = input.reauthRequired ? "reauth_required" : "active";
    connection.leaseOwner = null;
    connection.leaseExpiresAt = input.reauthRequired
      ? null
      : new Date(
          Date.now() + Math.min(60, 2 ** Math.min(connection.failureCount - 1, 6)) * 1000
        ).toISOString();
    connection.updatedAt = new Date().toISOString();
  }

  async beginWechatMessage(connectionId: string, messageId: string): Promise<boolean> {
    const key = `${connectionId}:${messageId}`;
    const current = this.receipts.get(key);
    if (current === "processing" || current === "completed") return false;
    this.receipts.set(key, "processing");
    return true;
  }

  async completeWechatMessage(
    connectionId: string,
    messageId: string,
    error?: string
  ): Promise<void> {
    this.receipts.set(
      `${connectionId}:${messageId}`,
      error ? "failed" : "completed"
    );
  }
}
