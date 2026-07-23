import { createHash } from "node:crypto";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  WechatILinkClient,
  type WechatConnection,
  type WechatInboundMessage,
  type WechatUpdates
} from "@tomeet/wechat-ilink";

type RuntimeStore = Pick<
  WechatConnectionStore,
  | "beginWechatMessage"
  | "completeWechatMessage"
  | "markWechatConnectionError"
  | "releaseWechatConnection"
  | "renewWechatConnectionLease"
  | "updateWechatConnectionCursor"
>;

export interface AgentTextClient {
  sendText(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    content: string;
  }): Promise<string>;
}

export interface WechatTransport {
  getUpdates(input: {
    baseUrl: string;
    botToken: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<WechatUpdates>;
  sendText(input: {
    baseUrl: string;
    botToken: string;
    toUserId: string;
    text: string;
    contextToken?: string;
    runId?: string;
  }): Promise<string>;
}

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface WechatRuntimeDependencies {
  store: RuntimeStore;
  cipher: CredentialCipher;
  ilink: WechatTransport;
  tomeet: AgentTextClient;
  logger?: WorkerLogger;
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export async function handleWechatMessage(
  dependencies: WechatRuntimeDependencies,
  connection: WechatConnection,
  botToken: string,
  message: WechatInboundMessage
): Promise<boolean> {
  if (
    message.message_type !== 1
    || !message.from_user_id
    || message.from_user_id !== connection.ownerIlinkUserId
  ) {
    return false;
  }
  const id = message.message_id !== undefined
    ? String(message.message_id)
    : message.client_id?.trim() || null;
  if (!id) return false;

  const started = await dependencies.store.beginWechatMessage(connection.id, id);
  if (!started) return false;

  try {
    const content = WechatILinkClient.extractText(message);
    const reply = content
      ? await dependencies.tomeet.sendText({
          connectionId: connection.id,
          messageId: id,
          userId: connection.userId,
          content
        })
      : "目前支持文字消息和带转写的语音消息，图片与文件能力正在接入。";
    await dependencies.ilink.sendText({
      baseUrl: connection.baseUrl,
      botToken,
      toUserId: connection.ownerIlinkUserId,
      text: reply,
      contextToken: message.context_token,
      runId: message.run_id
    });
    await dependencies.store.completeWechatMessage(connection.id, id);
    (dependencies.logger ?? console).info(JSON.stringify({
      level: "info",
      event: "wechat_message_completed",
      connection: fingerprint(connection.id),
      user: fingerprint(connection.ownerIlinkUserId),
      kind: content ? "agent" : "unsupported_media"
    }));
    return true;
  } catch (error) {
    await dependencies.store.completeWechatMessage(
      connection.id,
      id,
      errorMessage(error)
    );
    throw error;
  }
}

export async function monitorWechatConnection(
  dependencies: WechatRuntimeDependencies & {
    connection: WechatConnection;
    workerId: string;
    leaseSeconds: number;
    signal: AbortSignal;
  }
): Promise<void> {
  const {
    connection,
    workerId,
    leaseSeconds,
    signal
  } = dependencies;
  const logger = dependencies.logger ?? console;
  const connectionFingerprint = fingerprint(connection.id);
  try {
    const botToken = dependencies.cipher.decrypt(
      connection.botTokenCiphertext,
      `wechat-connection:${connection.ownerIlinkUserId}`
    );
    let cursor = connection.syncCursor;
    while (!signal.aborted) {
      const renewed = await dependencies.store.renewWechatConnectionLease(
        connection.id,
        workerId,
        leaseSeconds
      );
      if (!renewed) return;

      const updates = await dependencies.ilink.getUpdates({
        baseUrl: connection.baseUrl,
        botToken,
        cursor,
        signal
      });
      if (signal.aborted) return;
      if ((updates.ret && updates.ret !== 0) || (updates.errcode && updates.errcode !== 0)) {
        const code = updates.errcode ?? updates.ret;
        const reauthRequired = code === -14;
        await dependencies.store.markWechatConnectionError({
          connectionId: connection.id,
          workerId,
          message: `iLink getUpdates failed (${code ?? "unknown"}): ${updates.errmsg ?? "unknown"}`,
          reauthRequired
        });
        logger.error(JSON.stringify({
          level: "error",
          event: reauthRequired ? "wechat_reauth_required" : "wechat_updates_failed",
          connection: connectionFingerprint,
          code
        }));
        return;
      }

      let handled = false;
      for (const inbound of updates.msgs ?? []) {
        handled = (
          await handleWechatMessage(dependencies, connection, botToken, inbound)
        ) || handled;
      }
      cursor = updates.get_updates_buf ?? cursor;
      const updated = await dependencies.store.updateWechatConnectionCursor(
        connection.id,
        workerId,
        cursor,
        handled ? new Date().toISOString() : undefined
      );
      if (!updated) return;
    }
  } catch (error) {
    await dependencies.store.markWechatConnectionError({
      connectionId: connection.id,
      workerId,
      message: errorMessage(error),
      reauthRequired: false
    }).catch(() => undefined);
    logger.error(JSON.stringify({
      level: "error",
      event: "wechat_connection_monitor_failed",
      connection: connectionFingerprint,
      errorType: errorName(error)
    }));
  } finally {
    await dependencies.store.releaseWechatConnection(
      connection.id,
      workerId
    ).catch(() => undefined);
  }
}
