import { createHash } from "node:crypto";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  WechatILinkClient,
  type WechatConnection,
  type WechatInboundMessage,
  type WechatOutboundDelivery,
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
  sendEvent(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    event: {
      kind: "unsupported_channel_message";
      facts: Record<string, unknown>;
    };
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
  bubbleDelayMs?: number;
}

export interface WechatOutboundDependencies {
  store: Pick<WechatConnectionStore, "completeWechatOutboundMessage">;
  cipher: CredentialCipher;
  ilink: Pick<WechatTransport, "sendText">;
  logger?: WorkerLogger;
  bubbleDelayMs?: number;
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

const WECHAT_BUBBLE_MAX_CHARS = 260;

function stripTerminalPeriods(content: string): string {
  return content.trim().replace(/[。.]+$/u, "").trimEnd();
}

function splitLongBubble(content: string, maxChars = WECHAT_BUBBLE_MAX_CHARS): string[] {
  const pending = Array.from(content.trim());
  const chunks: string[] = [];
  while (pending.length > maxChars) {
    const minimumBreak = Math.floor(maxChars * 0.6);
    let breakAt = -1;
    for (let index = maxChars; index >= minimumBreak; index -= 1) {
      if (/[，,；;：:\s]/u.test(pending[index - 1] ?? "")) {
        breakAt = index;
        break;
      }
    }
    if (breakAt < 1) breakAt = maxChars;
    const chunk = stripTerminalPeriods(pending.splice(0, breakAt).join(""));
    if (chunk) chunks.push(chunk);
    while (/\s/u.test(pending[0] ?? "")) pending.shift();
  }
  const remainder = stripTerminalPeriods(pending.join(""));
  if (remainder) chunks.push(remainder);
  return chunks;
}

function splitParagraphSentences(paragraph: string): string[] {
  const characters = Array.from(paragraph.replace(/\s*\n\s*/gu, " ").trim());
  const sentences: string[] = [];
  let current = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    current += character;
    const next = characters[index + 1];
    const isTerminal = /[。！？!?]/u.test(character)
      || (character === "." && (next === undefined || /\s/u.test(next) || next === "."));
    if (!isTerminal) continue;
    while (/[。！？!?.]/u.test(characters[index + 1] ?? "")) {
      index += 1;
      current += characters[index]!;
    }
    const sentence = stripTerminalPeriods(current);
    if (sentence) sentences.push(sentence);
    current = "";
    while (/\s/u.test(characters[index + 1] ?? "")) index += 1;
  }
  const remainder = stripTerminalPeriods(current);
  if (remainder) sentences.push(remainder);
  return sentences;
}

export function splitWechatBubbles(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("┏")) return [trimmed];
  const bubbles = trimmed
    .split(/\n\s*\n+/u)
    .flatMap((paragraph) => splitParagraphSentences(paragraph))
    .flatMap((sentence) => splitLongBubble(sentence))
    .filter(Boolean);
  return bubbles.length > 0 ? bubbles : [trimmed];
}

async function waitBetweenBubbles(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function deliverWechatOutboundMessage(
  dependencies: WechatOutboundDependencies,
  delivery: WechatOutboundDelivery,
  workerId: string
): Promise<void> {
  const logger = dependencies.logger ?? console;
  try {
    const botToken = dependencies.cipher.decrypt(
      delivery.connection.botTokenCiphertext,
      `wechat-connection:${delivery.connection.ownerIlinkUserId}`
    );
    const bubbles = splitWechatBubbles(delivery.content);
    for (const [index, bubble] of bubbles.entries()) {
      await dependencies.ilink.sendText({
        baseUrl: delivery.connection.baseUrl,
        botToken,
        toUserId: delivery.connection.ownerIlinkUserId,
        text: bubble,
        runId: `outbound-${delivery.id}-bubble-${index + 1}`
      });
      if (index < bubbles.length - 1) {
        await waitBetweenBubbles(dependencies.bubbleDelayMs ?? 0);
      }
    }
    await dependencies.store.completeWechatOutboundMessage(delivery.id, workerId);
    logger.info(JSON.stringify({
      level: "info",
      event: "wechat_outbound_completed",
      outbound: fingerprint(delivery.id),
      connection: fingerprint(delivery.connection.id),
      user: fingerprint(delivery.connection.ownerIlinkUserId),
      attempt: delivery.attempts
    }));
  } catch (error) {
    await dependencies.store.completeWechatOutboundMessage(
      delivery.id,
      workerId,
      errorMessage(error)
    ).catch(() => undefined);
    logger.error(JSON.stringify({
      level: "error",
      event: "wechat_outbound_failed",
      outbound: fingerprint(delivery.id),
      connection: fingerprint(delivery.connection.id),
      errorType: errorName(error),
      attempt: delivery.attempts
    }));
  }
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
      : await dependencies.tomeet.sendEvent({
          connectionId: connection.id,
          messageId: id,
          userId: connection.userId,
          event: {
            kind: "unsupported_channel_message",
            facts: {
              channel: "wechat",
              supportedInputs: ["text", "transcribed_audio"],
              receivedMessageType: message.message_type
            }
          }
        });
    const bubbles = splitWechatBubbles(reply);
    const runIdBase = message.run_id?.trim() || `inbound-${connection.id}-${id}`;
    for (const [index, bubble] of bubbles.entries()) {
      await dependencies.ilink.sendText({
        baseUrl: connection.baseUrl,
        botToken,
        toUserId: connection.ownerIlinkUserId,
        text: bubble,
        contextToken: message.context_token,
        runId: `${runIdBase}-bubble-${index + 1}`
      });
      if (index < bubbles.length - 1) {
        await waitBetweenBubbles(dependencies.bubbleDelayMs ?? 0);
      }
    }
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
