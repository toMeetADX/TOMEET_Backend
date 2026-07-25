import { randomUUID } from "node:crypto";
import { adventurexWelcomeContent } from "@tomeet/contracts";
import { describe, expect, it } from "vitest";
import { formatCandidatePreview } from "@tomeet/matchmaking";
import { MemoryStore } from "./memory-store.js";

describe("AdventureX MemoryStore", () => {
  it("sends the image-first welcome exactly once", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    const first = await store.startAdventurexOnboarding(userId);
    const second = await store.startAdventurexOnboarding(userId);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("欢迎消息缺失");
    expect(second.id).toBe(first.id);
    expect(first.content).toBe(adventurexWelcomeContent("zh"));
    expect((await store.listRecentMessages(userId)).filter((message) => message.id === first.id)).toHaveLength(1);
    expect(await store.ensureAdventurexOnboardingState(userId)).toMatchObject({
      stage: "awaiting_image_or_text",
      preferredLanguage: "zh",
      boundaryPromptedAt: null
    });
  });

  it("does not inject a welcome into an existing conversation", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    await store.appendMessage({ userId, role: "user", content: "我已经从网页聊过了" });

    await expect(store.startAdventurexOnboarding(userId, "en")).resolves.toBeNull();
    expect(await store.ensureAdventurexOnboardingState(userId)).toMatchObject({
      stage: "exploring",
      preferredLanguage: "en"
    });
  });

  it("records a boundary prompt only once", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    const first = await store.updateAdventurexOnboardingState(userId, { boundaryPrompted: true });
    const second = await store.updateAdventurexOnboardingState(userId, { boundaryPrompted: true });
    expect(first.boundaryPromptedAt).not.toBeNull();
    expect(second.boundaryPromptedAt).toBe(first.boundaryPromptedAt);
  });

  it("keeps social hooks traceable to owned user text", async () => {
    const store = new MemoryStore();
    const firstUser = randomUUID();
    const secondUser = randomUUID();
    const firstMessage = await store.appendMessage({ userId: firstUser, role: "user", content: "我独立做过一款游戏" });
    const secondMessage = await store.appendMessage({ userId: secondUser, role: "user", content: "我办过展览" });
    const hooks = await store.saveSocialHooks(firstUser, [{
      hookText: "独立做过一款游戏",
      evidenceMessageIds: [firstMessage.id]
    }]);
    expect(hooks[0]?.sourceMessageIds).toEqual([firstMessage.id]);
    await expect(store.saveSocialHooks(firstUser, [{
      hookText: "办过展览",
      evidenceMessageIds: [secondMessage.id]
    }])).rejects.toThrow("当前用户的文字消息");
  });

  it("settles accepted choices, fills an open room with version checks, and emits one notification per existing member", async () => {
    const store = new MemoryStore();
    const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const requestIds: string[] = [];
    const hookIds: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      await store.ensureUser(userId, `用户${index + 1}`);
      const message = await store.appendMessage({
        userId,
        role: "user",
        content: `我明确做过第${index + 1}件现场项目`
      });
      const hook = await store.saveSocialHooks(userId, [{
        hookText: `明确做过第${index + 1}件现场项目`,
        evidenceMessageIds: [message.id]
      }]);
      hookIds.push(hook[0]!.id);
      const request = await store.createMatchRequest(userId, { rawText: "想参加现场活动" });
      requestIds.push(request.requestId);
    }

    const scheduledAt = new Date(Date.now() + 1_000).toISOString();
    const round = await store.createOrGetMatchRound("round-primary", scheduledAt);
    for (const requestId of requestIds.slice(0, 3)) await store.addRequestToRound(round.roundId, requestId);
    const game = (await store.listOfflineGames()).find((item) => item.id === "game-story-table")!;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.saveRoundProposals({
      roundId: round.roundId,
      proposal: {
        drafts: [{
          tempDraftId: "draft-main",
          offlineGameId: game.id,
          targetPlayers: 4,
          candidateRequestIds: requestIds.slice(0, 3),
          rationale: "三人都能通过轮流讲述进入互动"
        }],
        userOptions: requestIds.slice(0, 3).map((requestId) => ({ requestId, tempDraftIds: ["draft-main"] }))
      },
      offers: requestIds.slice(0, 3).map((requestId, index) => ({
        requestId,
        sourceType: "draft" as const,
        tempDraftId: "draft-main",
        sourceVersion: 0,
        optionNumber: 1 as const,
        offlineGameId: game.id,
        previewText: formatCandidatePreview({ optionNumber: 1, game, possibleHooks: [`明确做过第${(index + 1) % 3 + 1}件现场项目`] }),
        hooks: [{
          hookId: hookIds[(index + 1) % 3]!,
          hookText: `明确做过第${(index + 1) % 3 + 1}件现场项目`,
          sourceUserId: userIds[(index + 1) % 3]!,
          certainty: "possible" as const
        }]
      })),
      offerExpiresAt: expiresAt
    });
    for (const requestId of requestIds.slice(0, 3)) {
      await store.saveMatchChoices(requestId, {
        preferredOptionNumber: 1,
        acceptedOptionNumbers: [1],
        requiredHookIds: [],
        rawText: "1"
      });
    }
    const state = await store.getRoundSettlementState(round.roundId);
    const roomIds = await store.settleMatchRound(round.roundId, [{
      draftId: state.drafts[0]!.draftId,
      offlineGameId: game.id,
      requestIds: requestIds.slice(0, 3),
      memberIds: userIds.slice(0, 3),
      targetPlayers: 4,
      summary: "现场互动测试"
    }]);
    const room = (await store.getRoom(roomIds[0]!))!;
    expect(room.recruitmentStatus).toBe("open");
    expect(await store.getRoomIntro(room.roomId, userIds[0]!)).toBeNull();
    await store.saveRoomIntro(
      room.roomId,
      userIds[0]!,
      "Agent 根据已确认成员生成的介绍：有人明确做过第2件现场项目",
      [hookIds[1]!]
    );
    expect(await store.getRoomIntro(room.roomId, userIds[0]!)).not.toContain("明确做过第1件现场项目");

    await store.setMatchRequestInterest(requestIds[3]!, {
      phase: "waiting",
      proactivePushEnabled: true
    });
    const secondRound = await store.createOrGetMatchRound("round-open", scheduledAt);
    await store.addRequestToRound(secondRound.roundId, requestIds[3]!);
    const openOffers = await store.saveRoundProposals({
      roundId: secondRound.roundId,
      proposal: null,
      offers: [{
        requestId: requestIds[3]!,
        sourceType: "open_room",
        roomId: room.roomId,
        sourceVersion: room.version,
        optionNumber: 1,
        offlineGameId: game.id,
        previewText: formatCandidatePreview({ optionNumber: 1, game, confirmedCount: 3, remainingSeats: 1 }),
        hooks: []
      }],
      offerExpiresAt: expiresAt
    });
    await store.saveMatchChoices(requestIds[3]!, {
      preferredOptionNumber: 1,
      acceptedOptionNumbers: [1],
      requiredHookIds: [],
      rawText: "1"
    });
    const joined = await store.joinOpenRoom(requestIds[3]!, openOffers[0]!.offerId, 0);
    expect(joined.version).toBe(1);
    expect(joined.recruitmentStatus).toBe("full");
    expect(await store.listPendingRoomChangeNotifications()).toHaveLength(3);
    await expect(store.joinOpenRoom(requestIds[3]!, openOffers[0]!.offerId, 0)).rejects.toThrow();

    await expect(store.leaveRoom(joined.roomId, userIds[3]!)).rejects.toThrow("理由");
    await store.leaveRoom(joined.roomId, userIds[3]!, "临时有事");
    expect(await store.getLatestMatchRequestForUser(userIds[3]!)).toMatchObject({
      status: "matching",
      phase: "watching",
      proactivePushEnabled: true,
      roomId: null
    });
    expect((await store.listSuitableOpenRooms(userIds[3]!)).map((item) => item.roomId)).not.toContain(joined.roomId);
    expect(JSON.stringify(await store.listPendingRoomChangeNotifications())).not.toContain("临时有事");
    expect((await store.listPendingRoomChangeNotifications()).length).toBe(6);

    await store.leaveRoom(joined.roomId, userIds[0]!, "今天状态不太好");
    expect(await store.getLatestMatchRequestForUser(userIds[0]!)).toMatchObject({
      status: "cancelled",
      phase: "waiting",
      proactivePushEnabled: false,
      roomId: null
    });
    expect((await store.listPendingRoomChangeNotifications()).length).toBe(8);
  });

  it("creates a fresh request when rematching", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    const first = await store.createMatchRequest(userId, { rawText: "想认识人" });
    await store.cancelMatchRequest(first.requestId);
    const second = await store.restartMatch(first.requestId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.status).toBe("matching");
  });

  it("ends unmatched requests at round expiry and allows an explicit rematch", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    const first = await store.createMatchRequest(userId, { rawText: "想认识人" });
    const round = await store.createOrGetMatchRound("round-expired", new Date().toISOString());
    await store.addRequestToRound(round.roundId, first.requestId);
    await store.settleMatchRound(round.roundId, []);
    expect(await store.getMatchRequest(first.requestId)).toMatchObject({
      status: "expired",
      phase: "waiting",
      activeRoundId: null,
      optionsExpiresAt: null
    });
    const second = await store.restartMatch(first.requestId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.status).toBe("matching");
  });
});
