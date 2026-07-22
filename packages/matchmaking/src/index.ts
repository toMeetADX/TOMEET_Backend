import type { MatchDecision, MatchRequest, OfflineGame, UserModel } from "@tomeet/contracts";
import { gamesSupportingPlayerCount } from "@tomeet/game-catalog";

export interface MatchCandidate {
  request: MatchRequest;
  userModel: UserModel;
}

export interface MatchmakingIntelligence {
  decide(candidates: MatchCandidate[], games: OfflineGame[], requiredRequestId?: string): Promise<MatchDecision | null>;
}

export class MockMatchmakingIntelligence implements MatchmakingIntelligence {
  async decide(candidates: MatchCandidate[], games: OfflineGame[], requiredRequestId?: string): Promise<MatchDecision | null> {
    const waiting = candidates
      .filter(({ request }) => request.status === "matching")
      .sort((a, b) => Number(b.request.requestId === requiredRequestId) - Number(a.request.requestId === requiredRequestId))
      .slice(0, 10);
    if (waiting.length < 3) return null;
    const desiredSize = waiting.length >= 5 ? 5 : waiting.length;
    const selected = waiting.slice(0, desiredSize);
    const game = gamesSupportingPlayerCount(games, selected.length)[0];
    if (!game) return null;
    return {
      memberIds: selected.map(({ request }) => request.userId),
      requestIds: selected.map(({ request }) => request.requestId),
      offlineGameId: game.id,
      summary: `根据本次意图选择 ${selected.length} 人小组；${game.name}支持当前人数，并能通过共同任务降低初次见面的交流压力。`
    };
  }
}

export function validateMatchDecision(
  decision: MatchDecision,
  waitingRequests: MatchRequest[],
  game: OfflineGame | undefined,
  requiredRequestId?: string
): void {
  if (decision.memberIds.length < 3 || decision.memberIds.length > 10) throw new Error("匹配人数必须在 3–10 人之间");
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
  if (decision.memberIds.length < game.minPlayers || decision.memberIds.length > game.maxPlayers) {
    throw new Error("线下游戏不支持当前人数");
  }
}
