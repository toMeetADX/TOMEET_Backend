import { describe, expect, it } from "vitest";
import type { MatchRoom, OfflineGame } from "@tomeet/contracts";
import { createDefaultUserModel } from "@tomeet/user-model";
import {
  buildAgentContext,
  estimateTokens,
  MockAgentIntelligence,
  sanitizeMemoryCandidates,
  selectRelevantMemories
} from "./index.js";

describe("mock agent intelligence", () => {
  it("only detects explicit social intent", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"));
    expect((await intelligence.reply(context, "我喜欢摄影")).socialIntentDetected).toBe(false);
    const social = await intelligence.reply(context, "我想参加活动认识一些喜欢摄影的人");
    expect(social.socialIntentDetected).toBe(true);
    expect(social.actions[0]?.type).toBe("start_match");
  });

  it("summarizes old messages and reflects feedback", async () => {
    const intelligence = new MockAgentIntelligence();
    const summary = await intelligence.summarizeConversation("用户喜欢摄影", [{
      id: "m1",
      userId: "u1",
      role: "user",
      content: "最近也开始徒步",
      createdAt: new Date().toISOString()
    }]);
    expect(summary).toContain("最近也开始徒步");

    const reflection = await intelligence.reflectOnFeedback({
      userId: "u1",
      roomId: "room-1",
      peopleFeedback: "小组交流很自然",
      gameFeedback: "故事卡比竞技游戏舒服",
      connectionUserIds: [],
      nextIntent: "下次继续小组深聊"
    }, createDefaultUserModel("u1"));
    expect(reflection.currentIntent.nextIntent).toContain("小组深聊");
  });

  it("parses founder event-plan changes and keeps non-founders read-only", async () => {
    const now = nowIso();
    const game: OfflineGame = {
      id: "game-story-table",
      name: "故事交换桌",
      description: "通过故事卡自然交流",
      minPlayers: 3,
      maxPlayers: 6,
      intentTags: [],
      traits: [],
      requirements: [],
      instructions: []
    };
    const secondGame: OfflineGame = {
      ...game,
      id: "game-city-clues",
      name: "城市线索"
    };
    const room: MatchRoom = {
      roomId: "room-1",
      members: [
        {
          userId: "u1",
          displayName: "创始人一",
          confirmed: true,
          participationStatus: "confirmed",
          role: "founder"
        },
        {
          userId: "u2",
          displayName: "创始人二",
          confirmed: true,
          participationStatus: "confirmed",
          role: "founder"
        },
        {
          userId: "u3",
          displayName: "普通成员",
          confirmed: true,
          participationStatus: "confirmed",
          role: "member"
        }
      ],
      offlineGame: game,
      matchSummary: "自然匹配",
      status: "confirmed",
      sourceDraftId: null,
      targetPlayers: game.maxPlayers,
      recruitmentStatus: "open",
      version: 0,
      meetingPoint: null,
      matchingStatus: "active",
      capacity: game.maxPlayers,
      eventPlans: {
        draft: {
          planId: "plan-2",
          roomId: "room-1",
          version: 2,
          status: "draft",
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
          games: [{ game, primary: true, position: 0 }],
          confirmations: [],
          createdBy: "u1",
          createdAt: now,
          publishedAt: null
        },
        published: null
      },
      createdAt: now,
      completedAt: null
    };
    const intelligence = new MockAgentIntelligence();
    const founderContext = buildAgentContext([], createDefaultUserModel("u1"), {
      room,
      availableGames: [game, secondGame]
    });

    const changed = await intelligence.reply(founderContext, "地点改成人民公园");
    expect(changed.actions[0]).toMatchObject({
      type: "update_event_plan",
      expectedVersion: 2,
      patch: { location: { name: "人民公园" } }
    });
    const changedTime = await intelligence.reply(founderContext, "时间改到周六下午");
    expect(changedTime.actions[0]).toMatchObject({
      type: "update_event_plan",
      expectedVersion: 2,
      patch: { time: { note: "周六下午", timeZone: "Asia/Shanghai" } }
    });
    const changedGame = await intelligence.reply(founderContext, "游戏替换成城市线索");
    expect(changedGame.actions[0]).toMatchObject({
      type: "update_event_plan",
      expectedVersion: 2,
      patch: { gameIds: ["game-city-clues"] }
    });
    const confirmed = await intelligence.reply(founderContext, "方案没问题");
    expect(confirmed.actions[0]).toEqual({ type: "confirm_event_plan", version: 2 });
    const ambiguous = await intelligence.reply(founderContext, "清单改一下");
    expect(ambiguous.actions).toEqual([]);
    expect(ambiguous.reply).toContain("明确");

    const memberContext = buildAgentContext([], createDefaultUserModel("u3"), {
      room,
      availableGames: [game, secondGame]
    });
    const denied = await intelligence.reply(memberContext, "地点改成人民公园");
    expect(denied.actions).toEqual([]);
    expect(denied.reply).toContain("只有最初匹配的两位");

    const publishedRoom: MatchRoom = {
      ...room,
      eventPlans: {
        draft: null,
        published: {
          ...room.eventPlans.draft!,
          status: "published",
          confirmations: [
            { userId: "u1", displayName: "创始人一", confirmedAt: now },
            { userId: "u2", displayName: "创始人二", confirmedAt: now }
          ],
          publishedAt: now
        }
      }
    };
    const publishedContext = buildAgentContext([], createDefaultUserModel("u1"), {
      room: publishedRoom,
      availableGames: [game, secondGame]
    });
    const nextDraft = await intelligence.reply(publishedContext, "地点改成中山公园");
    expect(nextDraft.actions[0]).toMatchObject({
      type: "update_event_plan",
      expectedVersion: 2,
      patch: { location: { name: "中山公园" } }
    });
  });

  it("excludes the current user message and bounds every historical context section", () => {
    const now = new Date().toISOString();
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m-${index}`,
      userId: "u1",
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `第 ${index} 条消息 ${"很长的上下文".repeat(100)}`,
      createdAt: now
    }));
    const model = createDefaultUserModel("u1");
    const context = buildAgentContext(messages, model, {
      checkpoint: "旧 checkpoint ".repeat(1_000),
      excludeMessageId: "m-39"
    });
    expect(context.recentMessages.length).toBeGreaterThan(0);
    expect(context.recentMessages.length).toBeLessThanOrEqual(15);
    expect(context.recentMessages.some((message) => message.id === "m-39")).toBe(false);
    expect(estimateTokens(context.checkpoint)).toBeLessThanOrEqual(1_001);
    expect(context.budget.recentMessageTokens).toBeLessThanOrEqual(4_000);
    expect(context.budget.totalEstimatedTokens).toBeLessThanOrEqual(12_000);
  });

  it("rejects sensitive candidates and retrieves only bounded active memories", () => {
    const sanitized = sanitizeMemoryCandidates([
      {
        kind: "stable_fact",
        stableKey: "email",
        content: "我的邮箱是 person@example.com",
        expiresAt: null
      },
      {
        kind: "preference",
        stableKey: "coffee",
        content: "用户明确喜欢安静的咖啡馆",
        expiresAt: null
      }
    ], "message");
    expect(sanitized.rejectedCount).toBe(1);
    expect(sanitized.accepted).toHaveLength(1);

    const memory = {
      id: "memory-1",
      userId: "u1",
      kind: "preference" as const,
      stableKey: "coffee",
      content: "用户明确喜欢安静的咖啡馆",
      sourceType: "message" as const,
      sourceId: "message-1",
      explicitness: "explicit" as const,
      status: "active" as const,
      supersededBy: null,
      confirmationCount: 2,
      usageCount: 0,
      lastConfirmedAt: nowIso(),
      lastUsedAt: null,
      expiresAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    expect(selectRelevantMemories([memory], ["咖啡馆"], 6)).toHaveLength(1);
  });

  it("exposes confirmed social hooks so the Agent can see how far the profile has come", () => {
    const now = nowIso();
    const context = buildAgentContext([], createDefaultUserModel("u1"), {
      socialHooks: [{
        id: "hook-1",
        userId: "u1",
        hookText: "在黑客松上从零搭了一个社交 Agent",
        sourceMessageIds: ["m1"],
        status: "active",
        createdAt: now,
        updatedAt: now
      }]
    });
    expect(context.promptRuntime.profileReadiness).toEqual({
      confirmedSocialHooks: ["在黑客松上从零搭了一个社交 Agent"],
      confirmedSocialHookCount: 1
    });
    expect(buildAgentContext([], createDefaultUserModel("u1")).promptRuntime.profileReadiness)
      .toEqual({ confirmedSocialHooks: [], confirmedSocialHookCount: 0 });
  });

  it("turns an image observation into a question about the user instead of about the picture", async () => {
    const intelligence = new MockAgentIntelligence();
    const insight = await intelligence.reply(
      buildAgentContext([], createDefaultUserModel("u1")),
      [
        "[图片观察] 用户刚发来 2 张图片。",
        "可直接观察到：一张是技术分享会现场；一张是一碗面",
        "建议的追问方向：这场分享会你是去听的，还是自己上台讲的？"
      ].join("\n")
    );
    expect(insight.reply).toBe("这场分享会你是去听的，还是自己上台讲的？");
    expect(insight.onboardingTransition).toBe("engaged");
    expect(insight.socialHooks).toEqual([]);
  });

  it("moves to text after image refusal without asking why", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"), {
      onboardingState: {
        userId: "u1",
        stage: "awaiting_image_or_text",
        imageDeclined: false,
        preferredLanguage: "zh",
        boundaryPromptedAt: null,
        welcomeSentAt: nowIso(),
        welcomeDeliveredAt: nowIso(),
        updatedAt: nowIso()
      }
    });
    const insight = await intelligence.reply(context, "我不方便发图片");
    expect(insight.reply).toBe("好，那就不发。最近你把时间花得最多的一件事是什么？");
    expect(insight.reply).not.toContain("为什么");
  });

  it("switches to English without replaying the onboarding welcome", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"), {
      onboardingState: {
        userId: "u1",
        stage: "exploring",
        imageDeclined: false,
        preferredLanguage: "zh",
        boundaryPromptedAt: null,
        welcomeSentAt: nowIso(),
        welcomeDeliveredAt: nowIso(),
        updatedAt: nowIso()
      }
    });

    const insight = await intelligence.reply(context, "Please use English");
    expect(insight.onboardingTransition).toBe("language_en");
    expect(insight.reply).toContain("continue in English");
    expect(insight.reply).not.toContain("Hi there");
    expect(insight.actions).toEqual([]);
  });

  it("asks about social boundaries only once at the end of initial discovery", async () => {
    const intelligence = new MockAgentIntelligence();
    const messages = ["我最近在做一款游戏", "周末经常去看展"].map((content, index) => ({
      id: `message-${index}`,
      userId: "u1",
      role: "user" as const,
      content,
      createdAt: nowIso()
    }));
    const state = {
      userId: "u1",
      stage: "exploring" as const,
      imageDeclined: false,
      preferredLanguage: "zh" as const,
      boundaryPromptedAt: null,
      welcomeSentAt: nowIso(),
      welcomeDeliveredAt: nowIso(),
      updatedAt: nowIso()
    };
    const first = await intelligence.reply(buildAgentContext(messages, createDefaultUserModel("u1"), {
      onboardingState: state
    }), "最近也开始学摄影");
    expect(first.onboardingTransition).toBe("boundary_prompted");
    expect(first.reply).toContain("雷点");

    const second = await intelligence.reply(buildAgentContext(messages, createDefaultUserModel("u1"), {
      onboardingState: { ...state, boundaryPromptedAt: nowIso() }
    }), "最近也开始学摄影");
    expect(second.onboardingTransition).not.toBe("boundary_prompted");
  });

  it("only restarts an expired request after the user explicitly asks", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"), {
      matchRequest: {
        requestId: "request-expired",
        userId: "u1",
        intentSnapshot: { rawText: "想认识人" },
        status: "expired",
        phase: "waiting",
        proactivePushEnabled: false,
        activeRoundId: null,
        optionsExpiresAt: null,
        roomId: null,
        inviteId: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    });
    expect((await intelligence.reply(context, "知道了")).actions).toEqual([]);
    expect((await intelligence.reply(context, "再来三个")).actions).toEqual([{
      type: "restart_match",
      intent: { rawText: "想认识人" }
    }]);
  });

  it("distinguishes immediate retry from future push consent", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"), {
      matchRequest: {
        requestId: "request-push-consent",
        userId: "u1",
        intentSnapshot: { rawText: "想认识人" },
        status: "matching",
        phase: "push_consent",
        proactivePushEnabled: false,
        activeRoundId: null,
        optionsExpiresAt: null,
        roomId: null,
        inviteId: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    });

    expect((await intelligence.reply(context, "现在再匹配一次")).actions).toEqual([{ type: "activate_match" }]);
    expect((await intelligence.reply(context, "好，以后有合适的主动告诉我")).actions).toEqual([{ type: "enable_match_push" }]);
  });

  it("requires a simple reason before leaving a confirmed room", async () => {
    const intelligence = new MockAgentIntelligence();
    const now = new Date().toISOString();
    const room = {
      roomId: "room-confirmed",
      members: ["u1", "u2", "u3"].map((userId) => ({
        userId,
        displayName: userId,
        confirmed: true,
        participationStatus: "confirmed" as const,
        role: userId === "u1" || userId === "u2" ? "founder" as const : "member" as const
      })),
      offlineGame: {
        id: "game-story-table",
        name: "故事交换桌",
        description: "轮流分享现场故事",
        minPlayers: 3,
        maxPlayers: 6,
        intentTags: [],
        traits: [],
        requirements: [],
        instructions: []
      },
      matchSummary: "已经正式成局",
      status: "confirmed" as const,
      sourceDraftId: null,
      targetPlayers: 3,
      recruitmentStatus: "full" as const,
      version: 0,
      meetingPoint: null,
      matchingStatus: "full" as const,
      capacity: 3,
      eventPlans: { draft: null, published: null },
      createdAt: now,
      completedAt: null
    };
    const matchRequest = {
      requestId: "request-room",
      userId: "u1",
      intentSnapshot: { rawText: "想参加活动" },
      status: "matched" as const,
      phase: "settling" as const,
      proactivePushEnabled: true,
      activeRoundId: null,
      optionsExpiresAt: null,
      roomId: room.roomId,
      inviteId: null,
      createdAt: now,
      updatedAt: now
    };
    const context = buildAgentContext([], createDefaultUserModel("u1"), { room, matchRequest });

    const noReason = await intelligence.reply(context, "我不去了");
    expect(noReason.actions).toEqual([]);
    expect(noReason.reply).toMatch(/原因|理由/u);

    const withReason = await intelligence.reply(context, "临时有事，我不去了");
    expect(withReason.actions).toEqual([{ type: "leave_room", reason: "临时有事" }]);
    expect(withReason.reply).not.toContain("重新匹配");

    const followUpContext = buildAgentContext([{
      id: "ask-reason",
      userId: "u1",
      role: "assistant",
      content: noReason.reply,
      createdAt: now
    }], createDefaultUserModel("u1"), { room, matchRequest });
    expect((await intelligence.reply(followUpContext, "临时有事")).actions).toEqual([
      { type: "leave_room", reason: "临时有事" }
    ]);
  });

  it("clarifies an ambiguous band claim and only saves a sourced confirmed hook", async () => {
    const intelligence = new MockAgentIntelligence();
    const ambiguous = await intelligence.reply(
      buildAgentContext([], createDefaultUserModel("u1")),
      "以前我们组过乐队。",
      undefined,
      "m1"
    );
    expect(ambiguous.reply).toContain("你也是乐队成员吗");
    expect(ambiguous.socialHooks).toEqual([]);

    const context = buildAgentContext([{
      id: "m1",
      userId: "u1",
      role: "user",
      content: "以前我们组过乐队。",
      createdAt: nowIso()
    }], createDefaultUserModel("u1"));
    const confirmed = await intelligence.reply(context, "我是贝斯手，上台演过两次。", undefined, "m2");
    expect(confirmed.socialHooks).toEqual([{
      hookText: "当过乐队贝斯手并上台演出过两次",
      evidenceMessageIds: ["m1", "m2"]
    }]);
  });

  it("parses numeric, multi-option, and required-hook choices", async () => {
    const intelligence = new MockAgentIntelligence();
    const options = {
      requestId: "r1",
      roundId: "round1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      options: [1, 2, 3].map((optionNumber) => ({
        offerId: `o${optionNumber}`,
        requestId: "r1",
        roundId: "round1",
        sourceType: "draft" as const,
        draftId: `d${optionNumber}`,
        roomId: null,
        sourceVersion: 0,
        optionNumber: optionNumber as 1 | 2 | 3,
        offlineGameId: `g${optionNumber}`,
        activityName: `活动${optionNumber}`,
        activityDescription: "现场互动",
        previewText: `候选${optionNumber}`,
        hooks: optionNumber === 2 ? [{
          hookId: "hook-game",
          hookText: "独立做过一款像素游戏",
          sourceUserId: "u2",
          certainty: "possible" as const
        }] : [],
        status: "offered" as const,
        createdAt: nowIso(),
        respondedAt: null
      }))
    };
    const context = buildAgentContext([], createDefaultUserModel("u1"), { matchOptions: options });
    expect((await intelligence.reply(context, "3")).actions[0]).toMatchObject({
      type: "select_match_options",
      preferredOptionNumber: 3,
      acceptedOptionNumbers: [3]
    });
    expect((await intelligence.reply(context, "3 优先，1 也行")).actions[0]).toMatchObject({
      preferredOptionNumber: 3,
      acceptedOptionNumbers: [3, 1]
    });
    expect((await intelligence.reply(context, "有独立游戏开发者的那个")).actions[0]).toMatchObject({
      preferredOptionNumber: 2,
      requiredHookIds: ["hook-game"]
    });
  });

  it("renders invitation and confirmation examples without a right border", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"));
    const invitation = await intelligence.composeProductMessage(context, {
      kind: "match_options",
      facts: {
        options: [{
          optionNumber: 1,
          activityName: "故事交换桌",
          activityDescription: "围绕现场故事自然交流"
        }]
      }
    });
    const confirmation = await intelligence.composeProductMessage(context, {
      kind: "room_intro",
      facts: {
        activity: { name: "故事交换桌" },
        playerCount: 4,
        meetingPoint: "TOMEET 集合点",
        confirmedFacts: [{ hookText: "独立完成过一款游戏" }]
      }
    });

    expect(invitation.content).toContain("┃ TOMEET 组局邀请");
    expect(confirmation.content).toContain("┃ TOMEET 成局确认函");
    expect(confirmation.content).toContain("👥");
    expect(confirmation.content).toContain("📍");
    for (const content of [invitation.content, confirmation.content]) {
      expect(content.split("\n").every((line) => !/[┃│┫┤┓┐┛┘]\s*$/u.test(line))).toBe(true);
    }
  });
});

function nowIso(): string {
  return new Date().toISOString();
}
