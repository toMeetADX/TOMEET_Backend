import type {
  LlmJob,
  LlmJobType,
  MatchDecision,
  MatchRequest,
  MatchRoom,
  Message,
  OfflineGame,
  PostEventFeedback,
  UserModel
} from "@tomeet/contracts";
import type { MatchCandidate } from "@tomeet/matchmaking";

export interface EnqueueJobInput {
  type: LlmJobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface MultimodalRecordInput {
  userId: string;
  kind: "image" | "audio";
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  hint?: string;
}

export interface ConversationState {
  rollingSummary: string;
  summarizedMessageCount: number;
}

export interface DataStore {
  ensureUser(userId: string, displayName?: string): Promise<void>;
  appendMessage(input: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
  }): Promise<Message>;
  listRecentMessages(userId: string, limit?: number): Promise<Message[]>;
  listMessagesRange(userId: string, offset: number, limit: number): Promise<Message[]>;
  countMessages(userId: string): Promise<number>;
  getConversationState(userId: string): Promise<ConversationState>;
  saveConversationSummary(
    userId: string,
    rollingSummary: string,
    summarizedMessageCount: number,
    expectedSummarizedMessageCount: number
  ): Promise<void>;
  getUserModel(userId: string): Promise<UserModel>;
  saveUserModel(model: UserModel, expectedVersion: number): Promise<UserModel>;
  saveMultimodalInput(input: MultimodalRecordInput): Promise<string>;
  uploadFile(storagePath: string, mimeType: string, bytes: Uint8Array): Promise<void>;
  createSignedUpload(storagePath: string): Promise<{ path: string; token: string }>;
  resolveStorageUrl(storagePath: string): Promise<string>;
  updateMultimodalInput(inputId: string, understanding: Record<string, unknown>): Promise<void>;

  createMatchRequest(userId: string, intentSnapshot: Record<string, unknown>): Promise<MatchRequest>;
  getMatchRequest(requestId: string): Promise<MatchRequest | null>;
  getLatestMatchRequestForUser(userId: string): Promise<MatchRequest | null>;
  cancelMatchRequest(requestId: string): Promise<MatchRequest>;
  listMatchCandidates(limit?: number): Promise<MatchCandidate[]>;
  listOfflineGames(): Promise<OfflineGame[]>;
  createRoomFromDecision(decision: MatchDecision, sourceJobId?: string): Promise<string>;
  getRoom(roomId: string): Promise<MatchRoom | null>;
  getLatestRoomForUser(userId: string): Promise<MatchRoom | null>;
  confirmRoom(roomId: string, userId: string): Promise<MatchRoom>;
  completeRoom(roomId: string): Promise<MatchRoom>;
  saveFeedback(feedback: PostEventFeedback): Promise<string>;

  enqueueJob(input: EnqueueJobInput): Promise<LlmJob>;
  getJob(jobId: string): Promise<LlmJob | null>;
  claimJob(workerId: string): Promise<LlmJob | null>;
  completeJob(jobId: string, result: Record<string, unknown>): Promise<void>;
  failJob(jobId: string, error: string): Promise<void>;
  ping(): Promise<void>;
}

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}
