import type {
  FinalRoomDecision,
  GroupActivityJudgement,
  MatchChoice,
  MatchDecision,
  MatchDraft,
  MatchRequest,
  MatchRoom,
  MatchRoundProposal,
  OfflineGame,
  RoomJoinDecision,
  SocialHook,
  UserModel
} from "@tomeet/contracts";
import { matchRoundProposalSchema } from "@tomeet/contracts";

export interface MatchCandidate {
  request: Omit<MatchRequest, "phase" | "activeRoundId" | "optionsExpiresAt"> &
    Partial<Pick<MatchRequest, "phase" | "activeRoundId" | "optionsExpiresAt">>;
  userModel: UserModel;
  matchingNarrative?: string;
  socialHooks?: SocialHook[];
  matchingPriority?: "active_waiting" | "confirmation_follow_up" | "watching";
}

export interface RoomMatchCandidate {
  room: MatchRoom;
  members: MatchCandidate[];
}

export interface MatchmakingIntelligence {
  decide(candidates: MatchCandidate[], games: OfflineGame[], requiredRequestId?: string): Promise<MatchDecision | null>;
  proposeMatchRound(candidates: MatchCandidate[], games: OfflineGame[]): Promise<MatchRoundProposal | null>;
  judgeGroup(candidates: MatchCandidate[], game: OfflineGame): Promise<GroupActivityJudgement>;
  decideRoomJoin(
    candidates: MatchCandidate[],
    rooms: RoomMatchCandidate[],
    requiredRequestId?: string,
    requiredRoomId?: string
  ): Promise<RoomJoinDecision | null>;
}

export const MATCH_UTILITY_WEIGHTS = {
  preferred: 3,
  accepted: 1,
  waitingPerThirtySeconds: 0.2,
  waitingMaximum: 2,
  matchedUser: 2,
  activity: { bad: Number.NEGATIVE_INFINITY, acceptable: 0, good: 2, excellent: 4 }
} as const;

export class MockMatchmakingIntelligence implements MatchmakingIntelligence {
  async decide(candidates: MatchCandidate[], games: OfflineGame[], requiredRequestId?: string): Promise<MatchDecision | null> {
    const waiting = candidates
      .filter(({ request }) => request.status === "matching")
      .sort((a, b) => Number(b.request.requestId === requiredRequestId) - Number(a.request.requestId === requiredRequestId))
      .slice(0, 2);
    if (waiting.length < 2) return null;
    const selected = waiting;
    const game = games.find((item) => item.maxPlayers >= 2);
    if (!game) return null;
    return {
      memberIds: selected.map(({ request }) => request.userId),
      requestIds: selected.map(({ request }) => request.requestId),
      offlineGameId: game.id,
      summary: `先邀请当前最合适的两位用户建立房间，再按相同匹配机制逐位扩充至 ${game.maxPlayers} 人。`
    };
  }

  async decideRoomJoin(
    candidates: MatchCandidate[],
    rooms: RoomMatchCandidate[],
    requiredRequestId?: string,
    requiredRoomId?: string
  ): Promise<RoomJoinDecision | null> {
    const room = rooms.find((item) => item.room.roomId === requiredRoomId) ?? rooms[0];
    const candidate = candidates.find((item) => item.request.requestId === requiredRequestId) ?? candidates[0];
    if (!room || !candidate) return null;
    return {
      roomId: room.room.roomId,
      userId: candidate.request.userId,
      requestId: candidate.request.requestId,
      summary: `邀请当前队列中与房间整体氛围最匹配的下一位用户加入。`
    };
  }

  async proposeMatchRound(candidates: MatchCandidate[], games: OfflineGame[]): Promise<MatchRoundProposal | null> {
    const waiting = candidates
      .filter(({ request }) => request.status === "matching" && ["waiting", "watching"].includes(request.phase ?? "waiting"))
      .sort((left, right) => {
        const priorityRank = {
          active_waiting: 0,
          confirmation_follow_up: 1,
          watching: 2
        } as const;
        const leftPriority = priorityRank[left.matchingPriority
          ?? ((left.request.phase ?? "waiting") === "waiting" ? "active_waiting" : "watching")];
        const rightPriority = priorityRank[right.matchingPriority
          ?? ((right.request.phase ?? "waiting") === "waiting" ? "active_waiting" : "watching")];
        return leftPriority - rightPriority || left.request.createdAt.localeCompare(right.request.createdAt);
      })
      .slice(0, 24);
    const game = games.find((item) => waiting.length >= item.minPlayers);
    if (!game) return null;
    const groupSize = Math.min(waiting.length, game.maxPlayers, Math.max(game.minPlayers, 5));
    const drafts: MatchRoundProposal["drafts"] = [];
    const optionMap = new Map<string, string[]>();
    for (let offset = 0; offset + game.minPlayers <= waiting.length && drafts.length < 3; offset += groupSize) {
      const selected = waiting.slice(offset, offset + groupSize);
      if (selected.length < game.minPlayers) break;
      const tempDraftId = `draft-${drafts.length + 1}`;
      drafts.push({
        tempDraftId,
        offlineGameId: game.id,
        targetPlayers: selected.length,
        candidateRequestIds: selected.map((candidate) => candidate.request.requestId),
        rationale: `${game.name}能让这组现场参与者通过明确步骤自然进入互动。`
      });
      for (const candidate of selected) {
        const current = optionMap.get(candidate.request.requestId) ?? [];
        current.push(tempDraftId);
        optionMap.set(candidate.request.requestId, current);
      }
    }
    if (drafts.length === 0) return null;
    return {
      drafts,
      userOptions: [...optionMap].map(([requestId, tempDraftIds]) => ({ requestId, tempDraftIds }))
    };
  }

  async judgeGroup(candidates: MatchCandidate[], game: OfflineGame): Promise<GroupActivityJudgement> {
    return {
      verdict: candidates.length >= game.minPlayers && candidates.length <= game.maxPlayers ? "good" : "bad",
      isolationRiskUserIds: [],
      reasoning: `${game.name}提供了明确的共同任务和轮流参与方式。`
    };
  }
}

export function validateMatchDecision(
  decision: MatchDecision,
  waitingRequests: MatchRequest[],
  game: OfflineGame | undefined,
  requiredRequestId?: string
): void {
  if (decision.memberIds.length !== 2 || decision.requestIds.length !== 2) {
    throw new Error("初始匹配必须且只能包含两位用户");
  }
  if (new Set(decision.memberIds).size !== decision.memberIds.length) throw new Error("匹配成员不能重复");
  if (new Set(decision.requestIds).size !== decision.requestIds.length) throw new Error("匹配请求不能重复");
  if (decision.memberIds.length !== decision.requestIds.length) throw new Error("成员和请求数量不一致");
  if (requiredRequestId && !decision.requestIds.includes(requiredRequestId)) {
    throw new Error("匹配结果必须包含触发本次任务的用户");
  }

  const waitingById = new Map(waitingRequests.map((request) => [request.requestId, request]));
  decision.requestIds.forEach((requestId, index) => {
    const request = waitingById.get(requestId);
    if (!request || request.status !== "matching") throw new Error("匹配请求已不在等待中");
    if (request.userId !== decision.memberIds[index]) throw new Error("成员和匹配请求不对应");
  });

  if (!game || game.id !== decision.offlineGameId) throw new Error("只能选择目录中的线下游戏");
  if (game.maxPlayers < decision.memberIds.length) {
    throw new Error("线下游戏房间上限小于初始匹配人数");
  }
}

export function validateRoomJoinDecision(
  decision: RoomJoinDecision,
  waitingRequests: MatchRequest[],
  rooms: MatchRoom[],
  requiredRequestId?: string,
  requiredRoomId?: string
): void {
  const request = waitingRequests.find((item) => item.requestId === decision.requestId);
  if (!request || request.status !== "matching") throw new Error("入房候选请求已不在等待中");
  if (request.userId !== decision.userId) throw new Error("入房候选用户和请求不对应");
  if (requiredRequestId && decision.requestId !== requiredRequestId) {
    throw new Error("入房邀请必须使用触发本次任务的用户");
  }
  const room = rooms.find((item) => item.roomId === decision.roomId);
  if (!room || room.status === "completed" || room.matchingStatus !== "active") {
    throw new Error("目标房间已停止匹配");
  }
  if (requiredRoomId && room.roomId !== requiredRoomId) {
    throw new Error("入房邀请必须使用触发本次任务的房间");
  }
  if (room.members.length >= room.capacity) throw new Error("目标房间已满");
  if (room.members.some((member) => member.userId === decision.userId)) {
    throw new Error("候选用户已经在目标房间中");
  }
}

export function validateMatchRoundProposal(
  input: MatchRoundProposal,
  candidates: MatchCandidate[],
  games: OfflineGame[]
): MatchRoundProposal {
  const proposal = matchRoundProposalSchema.parse(input);
  const candidateIds = new Set(candidates.map((candidate) => candidate.request.requestId));
  const gameById = new Map(games.map((game) => [game.id, game]));
  const draftByTempId = new Map<string, MatchRoundProposal["drafts"][number]>();
  for (const draft of proposal.drafts) {
    if (draftByTempId.has(draft.tempDraftId)) throw new Error("tempDraftId 不能重复");
    draftByTempId.set(draft.tempDraftId, draft);
    const game = gameById.get(draft.offlineGameId);
    if (!game) throw new Error("候选局只能引用活动目录中的活动");
    if (draft.targetPlayers < game.minPlayers || draft.targetPlayers > game.maxPlayers) {
      throw new Error("候选局目标人数不符合活动范围");
    }
    if (draft.candidateRequestIds.some((requestId) => !candidateIds.has(requestId))) {
      throw new Error("候选局引用了输入之外的请求");
    }
    if (new Set(draft.candidateRequestIds).size !== draft.candidateRequestIds.length) {
      throw new Error("候选局请求不能重复");
    }
  }
  for (const userOption of proposal.userOptions) {
    if (!candidateIds.has(userOption.requestId)) throw new Error("用户候选引用了输入之外的请求");
    for (const tempDraftId of userOption.tempDraftIds) {
      const draft = draftByTempId.get(tempDraftId);
      if (!draft || !draft.candidateRequestIds.includes(userOption.requestId)) {
        throw new Error("用户只能看到自己属于候选池的局");
      }
    }
  }
  return proposal;
}

function formatHookPeople(hooks: string[]): string {
  return hooks.map((hook) => `${hook}的人`).join("、");
}

/** Test/example harness only. Production candidate copy is composed by AgentIntelligence. */
export function formatCandidatePreview(input: {
  optionNumber: number;
  game: Pick<OfflineGame, "name" | "description">;
  confirmedHooks?: string[];
  possibleHooks?: string[];
  confirmedCount?: number;
  remainingSeats?: number;
}): string {
  const confirmedHooks = input.confirmedHooks ?? [];
  const possibleHooks = input.possibleHooks ?? [];
  const lines = [`**${input.optionNumber}｜${input.game.name}**`, input.game.description];
  if (typeof input.confirmedCount === "number") {
    const seatText = typeof input.remainingSeats === "number" && input.remainingSeats > 0
      ? `，还差 ${input.remainingSeats} 个位置`
      : "";
    lines[1] = `这个局已经有 ${input.confirmedCount} 个人确认${seatText}。${input.game.description}`;
  }
  if (confirmedHooks.length > 0 && possibleHooks.length > 0) {
    lines.push(`这里已经有${formatHookPeople(confirmedHooks)}确认参加；你还可能遇见${formatHookPeople(possibleHooks)}。`);
  } else if (confirmedHooks.length > 0) {
    lines.push(`这里已经有${formatHookPeople(confirmedHooks)}确认参加。`);
  } else if (possibleHooks.length > 0) {
    lines.push(`你可能遇见${formatHookPeople(possibleHooks)}。`);
  }
  return lines.join("\n");
}

/** Test/example harness only. Production room copy is composed by AgentIntelligence. */
export function formatConfirmedIntro(input: {
  optionNumber?: number;
  game: Pick<OfflineGame, "name" | "description">;
  hookTexts: string[];
  playerCount: number;
  meetingPoint?: string | null;
}): string {
  const lines = [
    "成局了。",
    `**${input.optionNumber ?? 1}｜${input.game.name}**`,
    input.game.description
  ];
  if (input.hookTexts.length > 0) {
    lines.push(`这里有人${input.hookTexts.slice(0, 3).join("；有人")}。`);
  }
  lines.push(`你们一共 ${input.playerCount} 个人${input.meetingPoint ? `，去 ${input.meetingPoint} 集合` : ""}。`);
  return lines.join("\n\n");
}

export interface FinalGroupCandidate {
  decision: FinalRoomDecision;
  utility: number;
  choices: MatchChoice[];
}

function combinations<T>(items: T[], size: number, limit: number): T[][] {
  const output: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (output.length >= limit) return;
    if (selected.length === size) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      selected.push(items[index]!);
      visit(index + 1, selected);
      selected.pop();
      if (output.length >= limit) return;
    }
  };
  visit(0, []);
  return output;
}

export function generateFinalGroupCandidates(input: {
  drafts: MatchDraft[];
  choices: MatchChoice[];
  requests: MatchRequest[];
  games: OfflineGame[];
  hookSourceUserById?: Map<string, string>;
  now?: Date;
}): FinalGroupCandidate[] {
  const requestById = new Map(input.requests.map((request) => [request.requestId, request]));
  const gameById = new Map(input.games.map((game) => [game.id, game]));
  const hookSources = input.hookSourceUserById ?? new Map<string, string>();
  const now = (input.now ?? new Date()).getTime();
  const output: FinalGroupCandidate[] = [];
  for (const draft of input.drafts.filter((item) => item.status === "collecting")) {
    const game = gameById.get(draft.offlineGameId);
    if (!game) continue;
    const accepted = input.choices
      .filter((choice) => choice.sourceType === "draft" && choice.draftId === draft.draftId)
      .filter((choice) => requestById.get(choice.requestId)?.status === "matching");
    const unique = [...new Map(accepted.map((choice) => [choice.requestId, choice])).values()];
    if (unique.length < game.minPlayers) continue;
    const groupSizes: number[] = [];
    if (unique.length <= game.maxPlayers) {
      groupSizes.push(unique.length);
    } else if (unique.length >= game.minPlayers * 2 && unique.length <= game.maxPlayers * 2) {
      const first = Math.min(game.maxPlayers, Math.ceil(unique.length / 2));
      const second = unique.length - first;
      if (second >= game.minPlayers) groupSizes.push(first, second);
      else groupSizes.push(game.maxPlayers);
    } else {
      groupSizes.push(game.maxPlayers);
    }
    let offset = 0;
    for (const size of groupSizes) {
      const pools = groupSizes.length > 1
        ? [unique.slice(offset, offset + size)]
        : combinations(unique, size, 40);
      offset += size;
      for (const groupChoices of pools) {
        const requestIds = groupChoices.map((choice) => choice.requestId);
        const members = requestIds.map((requestId) => requestById.get(requestId)!).filter(Boolean);
        const memberIds = members.map((request) => request.userId);
        if (new Set(memberIds).size !== memberIds.length) continue;
        const requiredSatisfied = groupChoices.every((choice) => choice.requiredHookIds.every((hookId) => {
          const sourceUserId = hookSources.get(hookId);
          return sourceUserId ? memberIds.includes(sourceUserId) : false;
        }));
        if (!requiredSatisfied) continue;
        const preference = groupChoices.reduce((sum, choice) =>
          sum + (choice.preferenceRank === 1 ? MATCH_UTILITY_WEIGHTS.preferred : MATCH_UTILITY_WEIGHTS.accepted), 0);
        const waiting = members.reduce((sum, request) => {
          const thirtySeconds = Math.max(0, now - new Date(request.createdAt).getTime()) / 30_000;
          return sum + Math.min(MATCH_UTILITY_WEIGHTS.waitingMaximum, thirtySeconds * MATCH_UTILITY_WEIGHTS.waitingPerThirtySeconds);
        }, 0);
        output.push({
          decision: {
            draftId: draft.draftId,
            offlineGameId: draft.offlineGameId,
            requestIds,
            memberIds,
            targetPlayers: draft.targetPlayers,
            summary: draft.rationale
          },
          utility: preference + waiting + memberIds.length * MATCH_UTILITY_WEIGHTS.matchedUser,
          choices: groupChoices
        });
      }
    }
  }
  return output.slice(0, 200);
}

export function selectNonOverlappingGroups(candidates: FinalGroupCandidate[]): FinalGroupCandidate[] {
  const sorted = [...candidates].sort((left, right) => right.utility - left.utility);
  const selected: FinalGroupCandidate[] = [];
  const usedUsers = new Set<string>();
  for (const candidate of sorted) {
    if (candidate.decision.memberIds.some((userId) => usedUsers.has(userId))) continue;
    selected.push(candidate);
    candidate.decision.memberIds.forEach((userId) => usedUsers.add(userId));
  }
  return selected;
}

export function validateFinalRoomDecision(input: {
  decision: FinalRoomDecision;
  draft: MatchDraft | undefined;
  choices: MatchChoice[];
  requests: MatchRequest[];
  game: OfflineGame | undefined;
  hookSourceUserById?: Map<string, string>;
}): void {
  const { decision, draft, game } = input;
  if (!draft || draft.draftId !== decision.draftId || draft.status !== "collecting") throw new Error("候选局已不可结算");
  if (!game || game.id !== decision.offlineGameId) throw new Error("活动不存在");
  if (decision.memberIds.length < game.minPlayers || decision.memberIds.length > game.maxPlayers) throw new Error("活动人数不合法");
  if (new Set(decision.memberIds).size !== decision.memberIds.length) throw new Error("同一用户不能重复进入房间");
  const requestById = new Map(input.requests.map((request) => [request.requestId, request]));
  const memberIds = new Set(decision.memberIds);
  for (const [index, requestId] of decision.requestIds.entries()) {
    const request = requestById.get(requestId);
    if (!request || request.status !== "matching" || request.userId !== decision.memberIds[index]) {
      throw new Error("匹配请求已失效或与成员不对应");
    }
    const choice = input.choices.find((item) => item.requestId === requestId && item.draftId === draft.draftId);
    if (!choice) throw new Error("不能把用户放进未接受的候选局");
    for (const hookId of choice.requiredHookIds) {
      const sourceUserId = input.hookSourceUserById?.get(hookId);
      if (!sourceUserId || !memberIds.has(sourceUserId)) throw new Error("用户关注的人物未进入最终局");
    }
  }
}
