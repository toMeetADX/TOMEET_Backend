import { describe, expect, it } from "vitest";
import { curatedGames } from "@tomeet/game-catalog";
import {
  formatCandidatePreview,
  formatConfirmedIntro,
  generateFinalGroupCandidates,
  selectNonOverlappingGroups,
  validateMatchDecision
} from "./index.js";

describe("match decision validation", () => {
  it("rejects duplicated members", () => {
    expect(() => validateMatchDecision({
      memberIds: ["u1", "u1"],
      requestIds: ["r1", "r2"],
      offlineGameId: "game-story-table",
      summary: "test",
      eventPlanSeed: {
        time: {
          startsAt: null,
          endsAt: null,
          timeZone: "Asia/Shanghai",
          note: "待商定"
        },
        location: {
          name: null,
          address: null,
          url: null,
          note: "待商定"
        },
        gameIds: ["game-story-table"]
      }
    }, [], curatedGames[1])).toThrow("不能重复");
  });

  it("uses possible wording for previews and confirmed wording for final intros", () => {
    const game = curatedGames[1]!;
    expect(formatCandidatePreview({
      optionNumber: 2,
      game,
      possibleHooks: ["独立做过一款游戏"]
    })).toContain("你可能遇见独立做过一款游戏的人");
    const mixed = formatCandidatePreview({
      optionNumber: 2,
      game,
      confirmedHooks: ["正式演出过"],
      possibleHooks: ["独立做过一款游戏"]
    });
    expect(mixed).toContain("这里已经有正式演出过的人确认参加");
    expect(mixed).toContain("你还可能遇见独立做过一款游戏的人");
    expect(formatConfirmedIntro({
      game,
      hookTexts: ["独立做过一款游戏"],
      playerCount: 3
    })).toContain("这里有人独立做过一款游戏");
  });

  it("never forms a group without an accepted draft or required hook source", () => {
    const now = new Date().toISOString();
    const requests = ["u1", "u2", "u3", "u4"].map((userId, index) => ({
      requestId: `r${index + 1}`,
      userId,
      intentSnapshot: {},
      status: "matching" as const,
      phase: "selected" as const,
      proactivePushEnabled: false,
      activeRoundId: "round1",
      optionsExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      roomId: null,
      inviteId: null,
      createdAt: now,
      updatedAt: now
    }));
    const draft = {
      draftId: "d1",
      roundId: "round1",
      offlineGameId: "game-story-table",
      status: "collecting" as const,
      version: 0,
      targetPlayers: 3,
      candidateRequestIds: requests.map((request) => request.requestId),
      rationale: "共同活动",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const choices = requests.slice(0, 3).map((request, index) => ({
      choiceId: `c${index}`,
      requestId: request.requestId,
      roundId: "round1",
      sourceType: "draft" as const,
      draftId: "d1",
      roomId: null,
      preferenceRank: 1,
      requiredHookIds: index === 0 ? ["hook-u4"] : [],
      rawUserText: "可以",
      createdAt: now
    }));
    expect(generateFinalGroupCandidates({
      drafts: [draft],
      choices,
      requests,
      games: curatedGames,
      hookSourceUserById: new Map([["hook-u4", "u4"]])
    })).toHaveLength(0);
  });

  it("selects non-overlapping final groups", () => {
    const base = {
      draftId: "d1",
      offlineGameId: "game-story-table",
      targetPlayers: 3,
      summary: "test"
    };
    const selected = selectNonOverlappingGroups([
      { decision: { ...base, requestIds: ["r1", "r2", "r3"], memberIds: ["u1", "u2", "u3"] }, utility: 10, choices: [] },
      { decision: { ...base, draftId: "d2", requestIds: ["r4", "r5", "r6"], memberIds: ["u1", "u4", "u5"] }, utility: 9, choices: [] }
    ]);
    expect(selected).toHaveLength(1);
  });
});
