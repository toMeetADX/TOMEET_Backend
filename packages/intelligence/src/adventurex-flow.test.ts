import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { MemoryStore } from "@tomeet/data";
import {
  generateFinalGroupCandidates,
  MockMatchmakingIntelligence,
  selectNonOverlappingGroups,
  validateMatchRoundProposal
} from "@tomeet/matchmaking";
import {
  JobProcessor,
  scheduleAdventurexMatchRequest,
  scheduleMatchStatusHeartbeat
} from "./index.js";

describe("AdventureX 12-user integration", () => {
  afterEach(() => vi.useRealTimers());
  it("offers real drafts and settles at least two non-overlapping confirmed rooms", async () => {
    const store = new MemoryStore();
    const matcher = new MockMatchmakingIntelligence();
    const round = await store.createOrGetMatchRound("integration-12", new Date().toISOString());
    const requestIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const userId = randomUUID();
      await store.ensureUser(userId, `现场用户${index + 1}`);
      const source = await store.appendMessage({ userId, role: "user", content: `我完成过现场项目${index + 1}` });
      await store.saveSocialHooks(userId, [{
        hookText: `完成过现场项目${index + 1}`,
        evidenceMessageIds: [source.id]
      }]);
      const request = await store.createMatchRequest(userId, { rawText: `想自然认识几个人，编号${index + 1}` });
      requestIds.push(request.requestId);
      await store.addRequestToRound(round.roundId, request.requestId);
    }
    const [candidates, games] = await Promise.all([
      store.listRoundCandidates(round.roundId),
      store.listOfflineGames()
    ]);
    const proposal = validateMatchRoundProposal((await matcher.proposeMatchRound(candidates, games))!, candidates, games);
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    await store.saveRoundProposals({
      roundId: round.roundId,
      proposal,
      offers: proposal.userOptions.flatMap((userOption) => userOption.tempDraftIds.map((tempDraftId, index) => {
        const draft = proposal.drafts.find((item) => item.tempDraftId === tempDraftId)!;
        return {
          requestId: userOption.requestId,
          sourceType: "draft" as const,
          tempDraftId,
          sourceVersion: 0,
          optionNumber: (index + 1) as 1 | 2 | 3,
          offlineGameId: draft.offlineGameId,
          previewText: `**${index + 1}｜现场活动**\n你可能遇见其他候选成员。`,
          hooks: []
        };
      })),
      offerExpiresAt: expiresAt
    });
    for (const candidate of candidates) {
      const options = await store.listCurrentMatchOptions(candidate.request.userId);
      if (!options) continue;
      const optionNumber = options.options[0]!.optionNumber as 1 | 2 | 3;
      await store.saveMatchChoices(candidate.request.requestId, {
        preferredOptionNumber: optionNumber,
        acceptedOptionNumbers: [optionNumber],
        requiredHookIds: [],
        rawText: String(options.options[0]!.optionNumber)
      });
    }
    const state = await store.getRoundSettlementState(round.roundId);
    const generated = generateFinalGroupCandidates({
      drafts: state.drafts,
      choices: state.choices,
      requests: state.requests,
      games,
      hookSourceUserById: new Map(state.hooks.map((hook) => [hook.id, hook.userId]))
    });
    const selected = selectNonOverlappingGroups(generated);
    const roomIds = await store.settleMatchRound(round.roundId, selected.map((candidate) => candidate.decision));
    expect(roomIds.length).toBeGreaterThanOrEqual(2);
    const allMembers = (await Promise.all(roomIds.map((roomId) => store.getRoom(roomId))))
      .flatMap((room) => room?.members.filter((member) => member.participationStatus === "confirmed") ?? []);
    expect(new Set(allMembers.map((member) => member.userId)).size).toBe(allMembers.length);
    expect(allMembers.length).toBe(10);
    const remaining = await Promise.all(requestIds.map((requestId) => store.getMatchRequest(requestId)));
    expect(remaining.filter((request) => request?.status === "expired")).toHaveLength(2);
  });

  it("ends an unanswered offer window, notifies once, and waits for explicit rematch", async () => {
    const store = new MemoryStore();
    const matcher = new MockMatchmakingIntelligence();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), matcher, {
      adventurexMatchingV1: true
    });
    const userId = randomUUID();
    await store.ensureUser(userId, "超时用户");
    const request = await store.createMatchRequest(userId, { rawText: "想认识一些人" });
    const round = await store.createOrGetMatchRound("integration-timeout", new Date().toISOString());
    await store.addRequestToRound(round.roundId, request.requestId);
    const game = (await store.listOfflineGames()).find((item) => item.id === "game-story-table")!;
    await store.saveRoundProposals({
      roundId: round.roundId,
      proposal: {
        drafts: [{
          tempDraftId: "timeout-draft",
          offlineGameId: game.id,
          targetPlayers: 3,
          candidateRequestIds: [request.requestId],
          rationale: "等待用户选择"
        }],
        userOptions: [{ requestId: request.requestId, tempDraftIds: ["timeout-draft"] }]
      },
      offers: [{
        requestId: request.requestId,
        sourceType: "draft",
        tempDraftId: "timeout-draft",
        sourceVersion: 0,
        optionNumber: 1,
        offlineGameId: game.id,
        previewText: "**1｜故事交换桌**\n你可能遇见其他候选成员。",
        hooks: []
      }],
      offerExpiresAt: new Date(Date.now() - 1).toISOString()
    });
    const job = await store.enqueueJob({
      type: "match_round_settle",
      payload: { roundId: round.roundId },
      idempotencyKey: `match-round-settle:${round.roundId}`,
      partitionKey: `match-round:${round.roundId}`
    });

    await processor.process(job);
    await processor.process(job);

    expect(await store.getMatchRequest(request.requestId)).toMatchObject({ status: "expired" });
    const timeoutMessages = (await store.listRecentMessages(userId, 20))
      .filter((message) => message.id === `match-expired:${round.roundId}:${request.requestId}`);
    expect(timeoutMessages).toHaveLength(1);
    expect(timeoutMessages[0]?.content).toContain("超时");
    expect(timeoutMessages[0]?.content).toContain("再匹配");
    expect(await store.listRoundCandidates(round.roundId)).toHaveLength(0);
  });

  it("publishes a ten-second matching heartbeat and schedules the next one", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-25T12:00:00.000Z");
    vi.setSystemTime(now);
    const store = new MemoryStore();
    const processor = new JobProcessor(
      store,
      new MockAgentIntelligence(),
      new MockMatchmakingIntelligence(),
      { adventurexMatchingV1: true }
    );
    const userId = randomUUID();
    await store.ensureUser(userId, "心跳用户");
    const request = await store.createMatchRequest(userId, { rawText: "现在开始匹配" });
    const heartbeat = await scheduleMatchStatusHeartbeat(store, request.requestId, { now });
    expect(heartbeat.runAt).toBe("2026-07-25T12:00:10.000Z");

    vi.setSystemTime(new Date(now.getTime() + 10_000));
    const result = await processor.process(heartbeat);
    expect(result).toMatchObject({ sent: true, phase: "waiting", nextJobId: expect.any(String) });
    const progress = (await store.listRecentMessages(userId, 10))
      .find((message) => message.id.startsWith(`match-progress:${request.requestId}:`));
    expect(progress?.content).toContain("处理");
  });

  it("ends an unformed confirmation neutrally and prioritizes the accepting user among watchers", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-25T12:00:00.000Z");
    vi.setSystemTime(now);
    const store = new MemoryStore();
    const processor = new JobProcessor(
      store,
      new MockAgentIntelligence(),
      new MockMatchmakingIntelligence(),
      { adventurexMatchingV1: true }
    );
    const round = await store.createOrGetMatchRound("integration-confirmation-incomplete", new Date().toISOString());
    const users: Array<{ userId: string; requestId: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const userId = randomUUID();
      await store.ensureUser(userId, `确认用户${index + 1}`);
      const request = await store.createMatchRequest(userId, { rawText: "愿意参加这个局" });
      users.push({ userId, requestId: request.requestId });
      await store.addRequestToRound(round.roundId, request.requestId);
    }
    const game = (await store.listOfflineGames()).find((item) => item.id === "game-story-table")!;
    await store.saveRoundProposals({
      roundId: round.roundId,
      proposal: {
        drafts: [{
          tempDraftId: "confirmation-draft",
          offlineGameId: game.id,
          targetPlayers: 3,
          candidateRequestIds: users.map((user) => user.requestId),
          rationale: "等待多人确认"
        }],
        userOptions: users.map((user) => ({ requestId: user.requestId, tempDraftIds: ["confirmation-draft"] }))
      },
      offers: users.map((user) => ({
        requestId: user.requestId,
        sourceType: "draft" as const,
        tempDraftId: "confirmation-draft",
        sourceVersion: 0,
        optionNumber: 1 as const,
        offlineGameId: game.id,
        previewText: "**1｜故事交换桌**\n等待其他候选成员确认。",
        hooks: []
      })),
      offerExpiresAt: new Date(now.getTime() + 90_000).toISOString()
    });
    await store.saveMatchChoices(users[0]!.requestId, {
      preferredOptionNumber: 1,
      acceptedOptionNumbers: [1],
      requiredHookIds: [],
      rawText: "我愿意参加"
    });
    const settleJob = await store.enqueueJob({
      type: "match_round_settle",
      payload: { roundId: round.roundId },
      idempotencyKey: `match-round-settle:${round.roundId}`,
      partitionKey: `match-round:${round.roundId}`
    });

    vi.setSystemTime(new Date(now.getTime() + 91_000));
    await processor.process(settleJob);

    expect(await store.getMatchRequest(users[0]!.requestId)).toMatchObject({
      status: "matching",
      phase: "push_consent",
      proactivePushEnabled: false,
      activeRoundId: null
    });
    for (const user of users.slice(1)) {
      expect(await store.getMatchRequest(user.requestId)).toMatchObject({ status: "expired" });
    }
    const message = (await store.listRecentMessages(users[0]!.userId, 10))
      .find((item) => item.id === `match-confirmation-incomplete:${round.roundId}:${users[0]!.requestId}`);
    expect(message?.content).toContain("选择已经收到");
    expect(message?.content).not.toContain("拒绝");

    await store.setMatchRequestInterest(users[0]!.requestId, {
      phase: "watching",
      proactivePushEnabled: true,
      clearRound: true
    });
    const normalWatcherUserId = randomUUID();
    await store.ensureUser(normalWatcherUserId, "普通留意用户");
    const normalWatcher = await store.createMatchRequest(normalWatcherUserId, { rawText: "有合适的再说" });
    await store.setMatchRequestInterest(normalWatcher.requestId, {
      phase: "watching",
      proactivePushEnabled: true,
      clearRound: true
    });
    const activeUserId = randomUUID();
    await store.ensureUser(activeUserId, "当前高意愿用户");
    const active = await store.createMatchRequest(activeUserId, { rawText: "现在就想匹配" });
    const nextRound = await store.createOrGetMatchRound("integration-follow-up-priority", new Date().toISOString());
    await store.addRequestToRound(nextRound.roundId, active.requestId);

    const candidates = await store.listRoundCandidates(nextRound.roundId);
    expect(candidates.map((candidate) => candidate.request.requestId)).toEqual([
      active.requestId,
      users[0]!.requestId,
      normalWatcher.requestId
    ]);
    expect(candidates.map((candidate) => candidate.matchingPriority)).toEqual([
      "active_waiting",
      "confirmation_follow_up",
      "watching"
    ]);
  });

  it("ends an empty clearing tick immediately, then recalls an opted-in watcher when new users arrive", async () => {
    const store = new MemoryStore();
    const matcher = new MockMatchmakingIntelligence();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), matcher, {
      adventurexMatchingV1: true
    });
    const watcherUserId = randomUUID();
    await store.ensureUser(watcherUserId, "留意中的用户");
    const watcherRequest = await store.createMatchRequest(watcherUserId, { rawText: "想认识一些人" });
    const emptyRound = await store.createOrGetMatchRound("integration-empty", new Date().toISOString());
    await store.addRequestToRound(emptyRound.roundId, watcherRequest.requestId);
    const emptyJob = await store.enqueueJob({
      type: "match_round_generate",
      payload: { roundId: emptyRound.roundId },
      idempotencyKey: `match-round-generate:${emptyRound.roundId}`,
      partitionKey: `match-round:${emptyRound.roundId}`
    });

    const emptyResult = await processor.process(emptyJob);
    expect(emptyResult).toMatchObject({ offerCount: 0, settleJobId: null });
    expect(await store.getMatchRequest(watcherRequest.requestId)).toMatchObject({
      status: "matching",
      phase: "push_consent",
      proactivePushEnabled: false,
      activeRoundId: null
    });
    expect((await store.listRecentMessages(watcherUserId, 10)).at(-1)?.content).toContain("主动告诉你");

    await store.setMatchRequestInterest(watcherRequest.requestId, {
      phase: "watching",
      proactivePushEnabled: true,
      clearRound: true
    });
    const newRound = await store.createOrGetMatchRound("integration-recall", new Date().toISOString());
    for (let index = 0; index < 2; index += 1) {
      const userId = randomUUID();
      await store.ensureUser(userId, `新用户${index + 1}`);
      const request = await store.createMatchRequest(userId, { rawText: `现在想认识人${index + 1}` });
      await store.addRequestToRound(newRound.roundId, request.requestId);
    }
    const recallJob = await store.enqueueJob({
      type: "match_round_generate",
      payload: { roundId: newRound.roundId },
      idempotencyKey: `match-round-generate:${newRound.roundId}`,
      partitionKey: `match-round:${newRound.roundId}`
    });
    const recallResult = await processor.process(recallJob);
    expect(recallResult.offerCount).toBe(3);
    expect(await store.getMatchRequest(watcherRequest.requestId)).toMatchObject({
      status: "matching",
      phase: "offered",
      proactivePushEnabled: true,
      activeRoundId: newRound.roundId
    });
    expect(await store.listCurrentMatchOptions(watcherUserId)).not.toBeNull();
  });

  it("uses an owner-isolated virtual pool and auto-accepts only the test fixtures", async () => {
    const store = new MemoryStore();
    const matcher = new MockMatchmakingIntelligence();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), matcher, {
      adventurexMatchingV1: true
    });
    const ownerUserId = randomUUID();
    const unrelatedUserId = randomUUID();
    await store.ensureUser(ownerUserId, "测试池所有者");
    await store.ensureUser(unrelatedUserId, "真实池用户");
    await store.configureAdventurexTestPool(ownerUserId, { enabled: true, desiredUserCount: 5 });
    const unrelated = await store.createMatchRequest(unrelatedUserId, { rawText: "真实用户等待中" });
    const ownerRequest = await store.createMatchRequest(ownerUserId, { rawText: "测试一次匹配" });
    const scheduled = await scheduleAdventurexMatchRequest(store, ownerRequest, { now: new Date(0) });
    expect(scheduled.round.bucketKey).toContain(`adventurex-test:${ownerUserId}:`);
    const isolated = await store.listRoundCandidates(scheduled.round.roundId);
    expect(isolated).toHaveLength(6);
    expect(isolated.some((candidate) => candidate.request.requestId === unrelated.requestId)).toBe(false);

    const result = await processor.process(scheduled.job);
    expect(result.offerCount).toBe(5);
    const ownerOptions = await store.listCurrentMatchOptions(ownerUserId);
    expect(ownerOptions?.options).toHaveLength(1);
    await store.saveMatchChoices(ownerRequest.requestId, {
      preferredOptionNumber: 1,
      acceptedOptionNumbers: [1],
      requiredHookIds: [],
      rawText: "1"
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 91_000));
    const settleJob = await store.enqueueJob({
      type: "match_round_settle",
      payload: { roundId: scheduled.round.roundId },
      idempotencyKey: `virtual-settle-test:${scheduled.round.roundId}`,
      partitionKey: `match-round:${scheduled.round.roundId}`
    });
    const settled = await processor.process(settleJob);
    expect(settled.roomIds).toHaveLength(1);
    const room = await store.getRoom(String((settled.roomIds as string[])[0]));
    expect(room?.members).toHaveLength(5);
    expect(room?.members.some((member) => member.userId === unrelatedUserId)).toBe(false);
  });

  it("resumes a partially published collecting round without expiring its live offers", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(
      store,
      new MockAgentIntelligence(),
      new MockMatchmakingIntelligence(),
      { adventurexMatchingV1: true }
    );
    const round = await store.createOrGetMatchRound("integration-generate-retry", new Date().toISOString());
    const userIds: string[] = [];
    const requestIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const userId = randomUUID();
      userIds.push(userId);
      await store.ensureUser(userId, `重试用户${index + 1}`);
      const request = await store.createMatchRequest(userId, { rawText: "想认识一些人" });
      requestIds.push(request.requestId);
      await store.addRequestToRound(round.roundId, request.requestId);
    }
    const job = await store.enqueueJob({
      type: "match_round_generate",
      payload: { roundId: round.roundId },
      idempotencyKey: `match-round-generate:${round.roundId}`,
      partitionKey: `match-round:${round.roundId}`
    });

    const first = await processor.process(job);
    const resumed = await processor.process(job);

    expect(first.offerCount).toBe(3);
    expect(resumed).toMatchObject({ resumed: true, offerCount: 3 });
    expect(resumed.settleJobId).toEqual(expect.any(String));
    for (const [index, requestId] of requestIds.entries()) {
      expect(await store.getMatchRequest(requestId)).toMatchObject({ status: "matching", phase: "offered" });
      const messages = await store.listRecentMessages(userIds[index]!, 10);
      expect(messages.filter((message) => message.id === `match-options:${round.roundId}:${requestId}`)).toHaveLength(1);
    }
  });
});
