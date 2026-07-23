import type {
  MatchRequest,
  MatchRoom,
  Message,
  UserMemory,
  UserMemoryProfile,
  UserModel
} from "@tomeet/contracts";
import { estimateTokens, truncateToEstimatedTokens } from "./memory.js";

export interface AgentContextBudget {
  totalEstimatedTokens: number;
  recentMessageTokens: number;
  checkpointTokens: number;
  profileTokens: number;
  memoryTokens: number;
  runtimeTokens: number;
  truncatedSections: string[];
}

export interface AgentContext {
  recentMessages: Message[];
  checkpoint: string;
  profileNarrative: string;
  relevantMemories: UserMemory[];
  currentIntent: Record<string, unknown>;
  matchRequest: MatchRequest | null;
  room: MatchRoom | null;
  promptRuntime: Record<string, unknown>;
  budget: AgentContextBudget;
}

export interface ContextAssemblerOptions {
  totalTokenBudget?: number;
  recentMessageTokenBudget?: number;
  checkpointTokenBudget?: number;
  profileTokenBudget?: number;
  memoryTokenBudget?: number;
  runtimeTokenBudget?: number;
  maxRecentMessages?: number;
}

const DEFAULT_OPTIONS: Required<ContextAssemblerOptions> = {
  totalTokenBudget: 12_000,
  recentMessageTokenBudget: 4_000,
  checkpointTokenBudget: 1_000,
  profileTokenBudget: 1_200,
  memoryTokenBudget: 1_500,
  runtimeTokenBudget: 1_000,
  maxRecentMessages: 16
};

function selectRecentMessages(
  messages: Message[],
  maxMessages: number,
  maxTokens: number
): { messages: Message[]; tokens: number; truncated: boolean } {
  const selected: Message[] = [];
  let tokens = 0;
  for (const message of messages.slice(-maxMessages).reverse()) {
    const nextTokens = estimateTokens({ role: message.role, content: message.content });
    if (selected.length > 0 && tokens + nextTokens > maxTokens) break;
    if (nextTokens > maxTokens) {
      selected.push({
        ...message,
        content: truncateToEstimatedTokens(message.content, Math.max(1, maxTokens - 16))
      });
      tokens = maxTokens;
      break;
    }
    selected.push(message);
    tokens += nextTokens;
  }
  selected.reverse();
  return {
    messages: selected,
    tokens,
    truncated: selected.length < messages.length
  };
}

function selectMemories(
  memories: UserMemory[],
  maxTokens: number
): { memories: UserMemory[]; tokens: number; truncated: boolean } {
  const selected: UserMemory[] = [];
  let tokens = 0;
  for (const memory of memories.slice(0, 6)) {
    const nextTokens = estimateTokens({
      id: memory.id,
      kind: memory.kind,
      content: memory.content
    });
    if (tokens + nextTokens > maxTokens) break;
    selected.push(memory);
    tokens += nextTokens;
  }
  return {
    memories: selected,
    tokens,
    truncated: selected.length < memories.length
  };
}

function buildPromptRuntime(
  currentIntent: Record<string, unknown>,
  matchRequest: MatchRequest | null,
  room: MatchRoom | null,
  maxTokens: number
): Record<string, unknown> {
  const projected = {
    currentIntent,
    matchRequest: matchRequest
      ? {
          requestId: matchRequest.requestId,
          status: matchRequest.status,
          roomId: matchRequest.roomId,
          intentSnapshot: matchRequest.intentSnapshot
        }
      : null,
    room: room
      ? {
          roomId: room.roomId,
          status: room.status,
          members: room.members.map((member) => ({
            userId: member.userId,
            displayName: member.displayName,
            confirmed: member.confirmed
          })),
          offlineGame: {
            id: room.offlineGame.id,
            name: room.offlineGame.name,
            description: room.offlineGame.description
          },
          completedAt: room.completedAt
        }
      : null
  };
  if (estimateTokens(projected) <= maxTokens) return projected;
  return {
    currentIntentSummary: truncateToEstimatedTokens(JSON.stringify(currentIntent), Math.floor(maxTokens * 0.55)),
    matchRequest: matchRequest
      ? { requestId: matchRequest.requestId, status: matchRequest.status, roomId: matchRequest.roomId }
      : null,
    room: room
      ? {
          roomId: room.roomId,
          status: room.status,
          memberIds: room.members.map((member) => member.userId),
          offlineGame: {
            id: room.offlineGame.id,
            name: truncateToEstimatedTokens(room.offlineGame.name, 80)
          },
          completedAt: room.completedAt
        }
      : null
  };
}

export function buildAgentContext(
  messages: Message[],
  userModel: UserModel,
  socialState: {
    matchRequest?: MatchRequest | null;
    room?: MatchRoom | null;
    checkpoint?: string;
    memoryProfile?: UserMemoryProfile | null;
    relevantMemories?: UserMemory[];
    excludeMessageId?: string;
  } = {},
  options: ContextAssemblerOptions = {}
): AgentContext {
  const limits = { ...DEFAULT_OPTIONS, ...options };
  const truncatedSections: string[] = [];
  const historicalMessages = socialState.excludeMessageId
    ? messages.filter((message) => message.id !== socialState.excludeMessageId)
    : messages;
  const recent = selectRecentMessages(
    historicalMessages,
    limits.maxRecentMessages,
    limits.recentMessageTokenBudget
  );
  if (recent.truncated) truncatedSections.push("recentMessages");

  const rawCheckpoint = socialState.checkpoint ?? "";
  const checkpoint = truncateToEstimatedTokens(rawCheckpoint, limits.checkpointTokenBudget);
  if (checkpoint !== rawCheckpoint) truncatedSections.push("checkpoint");

  const rawProfile = socialState.memoryProfile && !socialState.memoryProfile.stale
    ? socialState.memoryProfile.profileNarrative
    : "";
  const profileNarrative = truncateToEstimatedTokens(rawProfile, limits.profileTokenBudget);
  if (profileNarrative !== rawProfile) truncatedSections.push("profileNarrative");

  const selectedMemories = selectMemories(
    socialState.relevantMemories ?? [],
    limits.memoryTokenBudget
  );
  if (selectedMemories.truncated) truncatedSections.push("relevantMemories");

  const matchRequest = socialState.matchRequest ?? null;
  const room = socialState.room ?? null;
  const promptRuntime = buildPromptRuntime(
    userModel.currentIntent,
    matchRequest,
    room,
    limits.runtimeTokenBudget
  );
  const runtimeTokens = estimateTokens(promptRuntime);
  if (estimateTokens({ currentIntent: userModel.currentIntent, matchRequest, room }) > runtimeTokens) {
    truncatedSections.push("runtimeState");
  }

  const totalEstimatedTokens = recent.tokens
    + estimateTokens(checkpoint)
    + estimateTokens(profileNarrative)
    + selectedMemories.tokens
    + runtimeTokens;
  if (totalEstimatedTokens > limits.totalTokenBudget) truncatedSections.push("totalBudget");

  return {
    recentMessages: recent.messages,
    checkpoint,
    profileNarrative,
    relevantMemories: selectedMemories.memories,
    currentIntent: structuredClone(userModel.currentIntent),
    matchRequest,
    room,
    promptRuntime,
    budget: {
      totalEstimatedTokens,
      recentMessageTokens: recent.tokens,
      checkpointTokens: estimateTokens(checkpoint),
      profileTokens: estimateTokens(profileNarrative),
      memoryTokens: selectedMemories.tokens,
      runtimeTokens,
      truncatedSections
    }
  };
}

export function countRecentMessagesToKeep(
  messages: Message[],
  maxMessages = 16,
  maxTokens = 4_000
): number {
  return selectRecentMessages(messages, maxMessages, maxTokens).messages.length;
}
