import { createHash, randomUUID } from "node:crypto";
import {
  channelSupportedInputs,
  channelTurnFailureNotice,
  channelTurnProgressNotices,
  type AdventurexLanguage
} from "@tomeet/contracts";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  DEFAULT_WECHAT_CDN_BASE_URL,
  WechatILinkClient,
  downloadWechatImage,
  type WechatConnection,
  type WechatInboundMessage,
  type WechatMessageItem,
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
  completeOnboardingWelcomeDelivery(input: {
    userId: string;
    claimId: string | null;
  }): Promise<void>;
  setResponseGeneration(input: {
    connectionId: string;
    generationToken: string;
  }): Promise<void>;
  sendTextBatch(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    turns: Array<{ messageId: string; content: string }>;
  }): Promise<{ reply: string | null; stale: boolean }>;
  sendText(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    content: string;
  }): Promise<string>;
  sendImages(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    images: Array<{
      messageId: string;
      bytes: Uint8Array;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
    }>;
    turns: Array<{ messageId: string; content?: string; imageCount: number }>;
  }): Promise<{ reply: string | null; stale: boolean }>;
  sendEvent(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    event: {
      kind: "unsupported_channel_message" | "channel_media_unreadable";
      facts: Record<string, unknown>;
    };
  }): Promise<string>;
}

export interface WechatTransport {
  getUpdates(input: {
    baseUrl: string;
    botToken: string;
    cursor?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<WechatUpdates>;
  sendText(input: {
    baseUrl: string;
    botToken: string;
    toUserId: string;
    text: string;
    contextToken?: string;
    runId?: string;
    clientId?: string;
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
  turnBatchWindowMs?: number;
  turnProgressDelayMs?: number;
  turnProgressIntervalMs?: number;
  turnProgressMaxNotices?: number;
  imageBatchWindowMs?: number;
  imageCdnBaseUrl?: string;
  downloadImage?: typeof downloadWechatImage;
  noticeLanguage?: AdventurexLanguage;
}

export interface WechatOutboundDependencies {
  store: Pick<WechatConnectionStore, "completeWechatOutboundMessage">;
  cipher: CredentialCipher;
  ilink: Pick<WechatTransport, "sendText">;
  tomeet: Pick<AgentTextClient, "completeOnboardingWelcomeDelivery">;
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
const WECHAT_IMAGE_BATCH_MAX = 9;
const WECHAT_TURN_PROGRESS_DELAY_MS = 60_000;
const WECHAT_TURN_PROGRESS_INTERVAL_MS = 30_000;
const WECHAT_TURN_PROGRESS_MAX_NOTICES = 1;
const WECHAT_LONG_POLL_DEFAULT_TIMEOUT_MS = 35_000;
const WECHAT_LONG_POLL_MIN_TIMEOUT_MS = 5_000;
const WECHAT_LONG_POLL_MAX_TIMEOUT_MS = 60_000;

function normalizedLongPollTimeout(value: number | undefined): number | null {
  if (!Number.isFinite(value) || !value || value <= 0) return null;
  return Math.min(
    WECHAT_LONG_POLL_MAX_TIMEOUT_MS,
    Math.max(WECHAT_LONG_POLL_MIN_TIMEOUT_MS, Math.round(value))
  );
}

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
  const characters = Array.from(paragraph.trim());
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

function splitExplicitBubbleSegments(content: string): string[] {
  return content
    // Models do not always preserve the requested blank line. A single line break still
    // represents an explicit WeChat bubble boundary.
    .split(/\s*\n+\s*/u)
    // Chinese prose normally has no ASCII spaces between clauses, so a space between two
    // Han segments is usually a flattened paragraph separator. Keep ordinary English word
    // spaces intact.
    .flatMap((line) => line.split(
      /(?<=[\p{Script=Han}，。！？!?…])[ \t\u3000]+(?=[\p{Script=Han}])/u
    ))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function splitWechatBubbles(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("┏")) return [trimmed];
  const bubbles = splitExplicitBubbleSegments(trimmed)
    .flatMap((paragraph) => splitParagraphSentences(paragraph))
    .flatMap((sentence) => splitLongBubble(sentence))
    .filter(Boolean);
  return bubbles.length > 0 ? bubbles : [trimmed];
}

async function waitBetweenBubbles(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

interface PendingWechatTurn {
  messageId: string;
  enqueuedAtMs: number;
  generationToken: string;
  contextToken?: string;
  runId?: string;
  content?: string;
  images: Array<{
    bytes: Uint8Array;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
  }>;
}

interface WechatTurnBatch {
  messages: PendingWechatTurn[];
  // A settled batch has already produced its user-visible outcome, so it must never be
  // folded back into a later batch by supersede().
  settled: boolean;
}

interface WechatTurnBatchSink {
  supersede(): Promise<string>;
  enqueue(message: PendingWechatTurn): Promise<void>;
  flush(): Promise<void>;
}

class WechatTurnProgressNotifier {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private noticeIndex = 0;

  constructor(
    private readonly dependencies: WechatRuntimeDependencies,
    private readonly connection: WechatConnection,
    private readonly botToken: string,
    private readonly contextToken: string | undefined,
    private readonly runIdBase: string,
    private readonly shouldContinue: () => boolean
  ) {}

  start(): void {
    this.schedule(this.dependencies.turnProgressDelayMs ?? WECHAT_TURN_PROGRESS_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.shouldContinue()) return;
    const notices = channelTurnProgressNotices[this.dependencies.noticeLanguage ?? "zh"];
    const maxNotices = this.dependencies.turnProgressMaxNotices
      ?? WECHAT_TURN_PROGRESS_MAX_NOTICES;
    if (this.noticeIndex >= notices.length || this.noticeIndex >= maxNotices) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || !this.shouldContinue()) return;
      const index = this.noticeIndex;
      const notice = notices[index];
      if (!notice) return;
      this.noticeIndex += 1;
      this.inFlight = this.dependencies.ilink.sendText({
        baseUrl: this.connection.baseUrl,
        botToken: this.botToken,
        toUserId: this.connection.ownerIlinkUserId,
        text: notice,
        contextToken: this.contextToken,
        runId: `${this.runIdBase}-progress-${index + 1}`
      }).then(() => {
        (this.dependencies.logger ?? console).info(JSON.stringify({
          level: "info",
          event: "wechat_turn_progress_sent",
          connection: fingerprint(this.connection.id),
          noticeIndex: index + 1
        }));
      }).catch((error: unknown) => {
        (this.dependencies.logger ?? console).error(JSON.stringify({
          level: "error",
          event: "wechat_turn_progress_failed",
          connection: fingerprint(this.connection.id),
          noticeIndex: index + 1,
          errorType: errorName(error)
        }));
      }).finally(() => {
        this.inFlight = null;
        this.schedule(
          this.dependencies.turnProgressIntervalMs ?? WECHAT_TURN_PROGRESS_INTERVAL_MS
        );
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }
}

async function sendReplyBubbles(input: {
  dependencies: Pick<WechatRuntimeDependencies, "ilink" | "bubbleDelayMs">;
  connection: WechatConnection;
  botToken: string;
  reply: string | readonly string[];
  contextToken?: string;
  runIdBase: string;
  clientIdBase?: string;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const bubbles = typeof input.reply === "string"
    ? splitWechatBubbles(input.reply)
    : [...input.reply];
  for (const [index, bubble] of bubbles.entries()) {
    if (input.shouldContinue && !input.shouldContinue()) return;
    await input.dependencies.ilink.sendText({
      baseUrl: input.connection.baseUrl,
      botToken: input.botToken,
      toUserId: input.connection.ownerIlinkUserId,
      text: bubble,
      contextToken: input.contextToken,
      runId: `${input.runIdBase}-bubble-${index + 1}`,
      clientId: input.clientIdBase
        ? `${input.clientIdBase}:bubble:${index + 1}`
        : undefined
    });
    if (index < bubbles.length - 1) {
      await waitBetweenBubbles(input.dependencies.bubbleDelayMs ?? 0);
    }
  }
}

class WechatTurnBatcher implements WechatTurnBatchSink {
  private pending: PendingWechatTurn[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private activeBatch: WechatTurnBatch | null = null;
  private latestGenerationToken: string | null = null;
  private notifiedFailureGeneration: string | null = null;
  private activeProgressNotifier: WechatTurnProgressNotifier | null = null;

  constructor(
    private readonly dependencies: WechatRuntimeDependencies,
    private readonly connection: WechatConnection,
    private readonly botToken: string
  ) {}

  async supersede(): Promise<string> {
    const generationToken = randomUUID();
    this.latestGenerationToken = generationToken;
    const activeProgressNotifier = this.activeProgressNotifier;
    this.activeProgressNotifier = null;
    await activeProgressNotifier?.stop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeBatch && !this.activeBatch.settled) {
      const pendingIds = new Set(this.pending.map((message) => message.messageId));
      this.pending = [
        ...this.activeBatch.messages.filter((message) => !pendingIds.has(message.messageId)),
        ...this.pending
      ];
    }
    this.pending = this.pending.map((message) => ({ ...message, generationToken }));
    await this.dependencies.tomeet.setResponseGeneration({
      connectionId: this.connection.id,
      generationToken
    });
    return generationToken;
  }

  async enqueue(message: PendingWechatTurn): Promise<void> {
    if (this.pending.reduce((count, item) => count + item.images.length, 0) + message.images.length
      > WECHAT_IMAGE_BATCH_MAX) {
      await this.flush();
    }
    this.pending.push(message);
    if (this.pending.reduce((count, item) => count + item.images.length, 0) >= WECHAT_IMAGE_BATCH_MAX) {
      await this.flush();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((error: unknown) => {
        (this.dependencies.logger ?? console).error(JSON.stringify({
          level: "error",
          event: "wechat_turn_batch_flush_failed",
          connection: fingerprint(this.connection.id),
          errorType: errorName(error)
        }));
      });
    }, this.dependencies.turnBatchWindowMs ?? this.dependencies.imageBatchWindowMs ?? 400);
  }

  async flush(): Promise<void> {
    // A previous batch that failed must not cancel this one: its error was already reported
    // to its own sender and its messages are never re-queued.
    if (this.flushing) await this.flushing.catch(() => undefined);
    if (this.pending.length === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch: WechatTurnBatch = { messages: this.pending, settled: false };
    this.pending = [];
    this.activeBatch = batch;
    this.flushing = this.deliver(batch).finally(() => {
      this.flushing = null;
      if (this.activeBatch === batch) this.activeBatch = null;
    });
    await this.flushing;
  }

  private async deliver(batch: WechatTurnBatch): Promise<void> {
    const batchStartedAt = Date.now();
    const batchQueueMs = Math.max(
      0,
      batchStartedAt - Math.min(...batch.messages.map((message) => message.enqueuedAtMs))
    );
    const messageIds = batch.messages.map((message) => message.messageId);
    const latest = batch.messages.at(-1)!;
    const batchKey = createHash("sha256").update(messageIds.join(":"))
      .digest("hex").slice(0, 20);
    try {
      const images = batch.messages
        .flatMap((message) => message.images.map((image) => ({
          ...image,
          messageId: message.messageId
        })))
        .slice(0, WECHAT_IMAGE_BATCH_MAX);
      const turns = batch.messages.map((message) => ({
        messageId: message.messageId,
        ...(message.content ? { content: message.content } : {}),
        imageCount: message.images.length
      }));
      const progressNotifier = new WechatTurnProgressNotifier(
        this.dependencies,
        this.connection,
        this.botToken,
        latest.contextToken,
        `turn-batch-${this.connection.id}-${batchKey}`,
        () => this.latestGenerationToken === latest.generationToken
      );
      this.activeProgressNotifier = progressNotifier;
      progressNotifier.start();
      let result: { reply: string | null; stale: boolean };
      const agentStartedAt = Date.now();
      try {
        result = images.length > 0
          ? await this.dependencies.tomeet.sendImages({
              connectionId: this.connection.id,
              generationToken: latest.generationToken,
              userId: this.connection.userId,
              images,
              turns
            })
          : await this.dependencies.tomeet.sendTextBatch({
              connectionId: this.connection.id,
              generationToken: latest.generationToken,
              userId: this.connection.userId,
              turns: turns.flatMap((turn) => turn.content
                ? [{ messageId: turn.messageId, content: turn.content }]
                : [])
            });
      } finally {
        await progressNotifier.stop();
        if (this.activeProgressNotifier === progressNotifier) {
          this.activeProgressNotifier = null;
        }
      }
      const agentMs = Date.now() - agentStartedAt;
      batch.settled = true;
      if (
        result.stale
        || !result.reply
        || this.latestGenerationToken !== latest.generationToken
      ) {
        await Promise.all(messageIds.map((messageId) => (
          this.dependencies.store.completeWechatMessage(this.connection.id, messageId)
        )));
        (this.dependencies.logger ?? console).info(JSON.stringify({
          level: "info",
          event: "wechat_turn_superseded",
          connection: fingerprint(this.connection.id),
          messageCount: batch.messages.length
        }));
        return;
      }
      const deliveryStartedAt = Date.now();
      await sendReplyBubbles({
        dependencies: this.dependencies,
        connection: this.connection,
        botToken: this.botToken,
        reply: result.reply,
        contextToken: latest.contextToken,
        runIdBase: latest.runId?.trim() || `turn-batch-${this.connection.id}-${batchKey}`,
        shouldContinue: () => this.latestGenerationToken === latest.generationToken
      });
      await Promise.all(messageIds.map((messageId) => (
        this.dependencies.store.completeWechatMessage(this.connection.id, messageId)
      )));
      const deliveryMs = Date.now() - deliveryStartedAt;
      (this.dependencies.logger ?? console).info(JSON.stringify({
        level: "info",
        event: "wechat_turn_batch_completed",
        connection: fingerprint(this.connection.id),
        user: fingerprint(this.connection.ownerIlinkUserId),
        imageCount: images.length,
        messageCount: batch.messages.length,
        batchQueueMs,
        agentMs,
        deliveryMs,
        totalMs: Date.now() - Math.min(...batch.messages.map((message) => message.enqueuedAtMs))
      }));
    } catch (error) {
      batch.settled = true;
      const detail = errorMessage(error);
      await Promise.all(messageIds.map((messageId) => (
        this.dependencies.store.completeWechatMessage(this.connection.id, messageId, detail)
      )));
      if (
        this.latestGenerationToken === latest.generationToken
        && this.notifiedFailureGeneration !== latest.generationToken
      ) {
        this.notifiedFailureGeneration = latest.generationToken;
        await sendReplyBubbles({
          dependencies: this.dependencies,
          connection: this.connection,
          botToken: this.botToken,
          reply: channelTurnFailureNotice[this.dependencies.noticeLanguage ?? "zh"],
          contextToken: latest.contextToken,
          runIdBase: `turn-batch-error-${this.connection.id}-${messageIds[0]}`,
          shouldContinue: () => this.latestGenerationToken === latest.generationToken
        }).catch(() => undefined);
      }
      throw error;
    }
  }
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
    let bubbles: string[];
    if (delivery.kind === "onboarding_welcome") {
      const plaintext = dependencies.cipher.decrypt(
        delivery.content,
        `wechat-welcome-delivery:${delivery.messageId}`
      );
      const payload = JSON.parse(plaintext) as { bubbles?: unknown; claimId?: unknown };
      if (
        !Array.isArray(payload.bubbles)
        || payload.bubbles.length === 0
        || payload.bubbles.some((bubble) => typeof bubble !== "string" || !bubble.trim())
        || (payload.claimId ?? null) !== delivery.claimId
      ) {
        throw new Error("Invalid encrypted onboarding welcome payload");
      }
      bubbles = payload.bubbles as string[];
    } else {
      bubbles = splitWechatBubbles(delivery.content);
    }
    for (const [index, bubble] of bubbles.entries()) {
      await dependencies.ilink.sendText({
        baseUrl: delivery.connection.baseUrl,
        botToken,
        toUserId: delivery.connection.ownerIlinkUserId,
        text: bubble,
        runId: `outbound-${delivery.id}-bubble-${index + 1}`,
        clientId: `tomeet:outbound:${delivery.id}:bubble:${index + 1}`
      });
      if (index < bubbles.length - 1) {
        await waitBetweenBubbles(dependencies.bubbleDelayMs ?? 0);
      }
    }
    if (delivery.kind === "onboarding_welcome") {
      await dependencies.tomeet.completeOnboardingWelcomeDelivery({
        userId: delivery.userId,
        claimId: delivery.claimId
      });
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
  message: WechatInboundMessage,
  turnBatcher?: WechatTurnBatchSink,
  openingTrigger?: boolean
): Promise<boolean> {
  const receivedAtMs = Date.now();
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
    // The first inbound only opens the iLink transport. A welcome task was created at activation
    // only when the WeChat identity did not already map to a database user.
    const isOpeningTrigger = openingTrigger ?? (
      Boolean(message.context_token) && !connection.lastMessageAt
    );
    if (isOpeningTrigger) {
      connection.lastMessageAt = new Date().toISOString();
      await dependencies.store.completeWechatMessage(connection.id, id);
      return true;
    }
    const content = WechatILinkClient.extractText(message);
    // Any image item counts as "the user sent a picture", even when the payload turns out to
    // be undownloadable: the reply must never claim pictures are unsupported.
    const imageItems = (message.item_list ?? []).filter((item): item is WechatMessageItem => (
      item.type === 2
    ));
    let unreadableImageCount = 0;
    if (imageItems.length > 0 || content) {
      const batcher = turnBatcher ?? new WechatTurnBatcher(
        { ...dependencies, turnBatchWindowMs: 0 },
        connection,
        botToken
      );
      const generationToken = await batcher.supersede();
      const downloader = dependencies.downloadImage ?? downloadWechatImage;
      const downloads = await Promise.allSettled(
        imageItems.slice(0, WECHAT_IMAGE_BATCH_MAX).map((item) => (
          downloader(item, {
            cdnBaseUrl: dependencies.imageCdnBaseUrl ?? DEFAULT_WECHAT_CDN_BASE_URL
          })
        ))
      );
      const images = downloads
        .filter((download) => download.status === "fulfilled")
        .map((download) => download.value);
      unreadableImageCount = downloads.length - images.length;
      if (unreadableImageCount > 0) {
        (dependencies.logger ?? console).error(JSON.stringify({
          level: "error",
          event: "wechat_image_unreadable",
          connection: fingerprint(connection.id),
          unreadableImageCount,
          errorTypes: downloads
            .filter((download) => download.status === "rejected")
            .map((download) => errorName(download.reason))
        }));
      }
      if (images.length > 0 || content) {
        await batcher.enqueue({
          messageId: id,
          enqueuedAtMs: receivedAtMs,
          generationToken,
          contextToken: message.context_token,
          runId: message.run_id,
          content: content ?? undefined,
          images
        });
        if (!turnBatcher) await batcher.flush();
        connection.lastMessageAt = new Date().toISOString();
        return true;
      }
    }
    // Nothing readable is left for this turn, so any earlier batch that supersede() pulled back
    // into the queue still owes the user its own reply.
    if (turnBatcher) await turnBatcher.flush().catch(() => undefined);
    const event = unreadableImageCount > 0
      ? {
          kind: "channel_media_unreadable" as const,
          facts: {
            channel: "wechat",
            receivedKinds: ["image"],
            unreadableCount: unreadableImageCount
          }
        }
      : {
          kind: "unsupported_channel_message" as const,
          facts: {
            channel: "wechat",
            supportedInputs: [...channelSupportedInputs],
            receivedMessageType: message.message_type
          }
        };
    const reply = await dependencies.tomeet.sendEvent({
      connectionId: connection.id,
      messageId: id,
      userId: connection.userId,
      event
    });
    const runIdBase = message.run_id?.trim() || `inbound-${connection.id}-${id}`;
    await sendReplyBubbles({
      dependencies,
      connection,
      botToken,
      reply,
      contextToken: message.context_token,
      runIdBase
    });
    await dependencies.store.completeWechatMessage(connection.id, id);
    (dependencies.logger ?? console).info(JSON.stringify({
      level: "info",
      event: "wechat_message_completed",
      connection: fingerprint(connection.id),
      user: fingerprint(connection.ownerIlinkUserId),
      kind: event.kind
    }));
    connection.lastMessageAt = new Date().toISOString();
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
  let turnBatcher: WechatTurnBatcher | null = null;
  try {
    const botToken = dependencies.cipher.decrypt(
      connection.botTokenCiphertext,
      `wechat-connection:${connection.ownerIlinkUserId}`
    );
    turnBatcher = new WechatTurnBatcher(dependencies, connection, botToken);
    let cursor = connection.syncCursor;
    let nextLongPollTimeoutMs = WECHAT_LONG_POLL_DEFAULT_TIMEOUT_MS;
    let consecutiveTransportTimeouts = 0;
    // Empty polling responses may advance the cursor before the user speaks, so lastMessageAt is
    // also needed only to identify the first transport opener. It does not decide who gets welcome.
    let openingTriggerPending = cursor.length === 0 || !connection.lastMessageAt;
    while (!signal.aborted) {
      const renewed = await dependencies.store.renewWechatConnectionLease(
        connection.id,
        workerId,
        leaseSeconds
      );
      if (!renewed) return;

      const pollStartedAt = Date.now();
      const cursorBeforePoll = cursor;
      const pollTimeoutMs = nextLongPollTimeoutMs;
      const updates = await dependencies.ilink.getUpdates({
        baseUrl: connection.baseUrl,
        botToken,
        cursor,
        timeoutMs: pollTimeoutMs,
        signal
      });
      if (signal.aborted) return;
      const providerLongPollTimeoutMs = normalizedLongPollTimeout(
        updates.longpolling_timeout_ms
      );
      if (providerLongPollTimeoutMs !== null) {
        nextLongPollTimeoutMs = providerLongPollTimeoutMs;
      }
      consecutiveTransportTimeouts = updates.transport_timed_out
        ? consecutiveTransportTimeouts + 1
        : 0;
      logger.info(JSON.stringify({
        level: "info",
        event: "wechat_updates_poll",
        connection: connectionFingerprint,
        durationMs: Date.now() - pollStartedAt,
        messageCount: updates.msgs?.length ?? 0,
        cursorChanged: (updates.get_updates_buf ?? cursorBeforePoll) !== cursorBeforePoll,
        expectedLongPollTimeoutMs: pollTimeoutMs,
        providerLongPollTimeoutMs,
        transportTimedOut: Boolean(updates.transport_timed_out),
        consecutiveTransportTimeouts
      }));
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
        try {
          const currentHandled = await handleWechatMessage(
            dependencies,
            connection,
            botToken,
            inbound,
            turnBatcher,
            openingTriggerPending
          );
          if (currentHandled && openingTriggerPending) openingTriggerPending = false;
          handled = currentHandled || handled;
        } catch (error) {
          // One unprocessable message must not drop the connection, because the cursor would
          // then stay put and iLink would redeliver the same message forever.
          handled = true;
          logger.error(JSON.stringify({
            level: "error",
            event: "wechat_message_failed",
            connection: connectionFingerprint,
            errorType: errorName(error)
          }));
        }
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
    await turnBatcher?.flush().catch(() => undefined);
    await dependencies.store.releaseWechatConnection(
      connection.id,
      workerId
    ).catch(() => undefined);
  }
}
