import type {
  MatchInvite,
  MatchRoom,
  RoomEventPlan
} from "@tomeet/contracts";
import type { DataStore } from "@tomeet/data";

function formatInstant(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

export function formatEventPlan(
  plan: RoomEventPlan,
  room?: MatchRoom | null
): string {
  const time = plan.time.startsAt
    ? [
        formatInstant(plan.time.startsAt, plan.time.timeZone),
        plan.time.endsAt ? `至 ${formatInstant(plan.time.endsAt, plan.time.timeZone)}` : null,
        plan.time.note
      ].filter(Boolean).join(" ")
    : plan.time.note || "待商定";
  const location = [
    plan.location.name,
    plan.location.address,
    plan.location.url,
    plan.location.note
  ].filter(Boolean).join(" · ") || "待商定";
  const games = plan.games
    .map((item, index) => `${index + 1}. ${item.game.name}${item.primary ? "（主游戏）" : ""}`)
    .join("\n");
  const founders = room?.members.filter((member) => member.role === "founder") ?? [];
  const confirmedIds = new Set(plan.confirmations.map((item) => item.userId));
  const progress = founders.length
    ? founders
        .map((founder) => `${founder.displayName} ${confirmedIds.has(founder.userId) ? "✅" : "⏳"}`)
        .join(" / ")
    : `${plan.confirmations.length}/2`;
  const instructions = plan.status === "draft"
    ? [
        "你可以直接回复：",
        "• “改到周六下午”",
        "• “地点改成……”",
        "• “增加/替换游戏……”",
        "• “确认这个清单”"
      ].join("\n")
    : "这是当前已发布的活动安排。";

  return [
    `活动清单 v${plan.version}（${plan.status === "published" ? "已发布" : "待确认"}）`,
    `时间：${time}`,
    `地点：${location}`,
    `游戏：\n${games}`,
    `创始人确认：${progress}`,
    instructions
  ].join("\n\n");
}

async function appendForUsers(
  store: DataStore,
  users: Array<{ userId: string }>,
  content: string,
  key: string,
  excludeUserId?: string
): Promise<void> {
  await Promise.all(users
    .filter((user) => user.userId !== excludeUserId)
    .map((user) => store.appendProactiveMessage({
      userId: user.userId,
      content,
      idempotencyKey: `${key}:${user.userId}`
    })));
}

export async function notifyEventPlanDraft(
  store: DataStore,
  room: MatchRoom,
  options: {
    reason: "created" | "updated" | "confirmed";
    actorName?: string;
    excludeUserId?: string;
  }
): Promise<void> {
  const plan = room.eventPlans.draft;
  if (!plan) return;
  const heading = options.reason === "created"
    ? "你们已经成功匹配并建立房间。请先一起确认活动清单；发布前不会继续邀请新成员。"
    : options.reason === "confirmed"
      ? `${options.actorName ?? "另一位创始成员"} 已确认这个版本，等待另一位创始成员确认。`
      : `${options.actorName ?? "另一位创始成员"} 修改了活动清单，请确认最新版本。`;
  await appendForUsers(
    store,
    room.members.filter((member) => member.role === "founder"),
    `${heading}\n\n${formatEventPlan(plan, room)}`,
    `event-plan:${plan.planId}:${options.reason}`,
    options.excludeUserId
  );
}

export async function notifyEventPlanPublished(
  store: DataStore,
  room: MatchRoom,
  options: { excludeUserId?: string } = {}
): Promise<void> {
  const plan = room.eventPlans.published;
  if (!plan) return;
  const recipients = [...room.members];
  const pendingInvite = await store.getPendingRoomJoinInviteForRoom(room.roomId);
  for (const participant of pendingInvite?.participants ?? []) {
    if (!recipients.some((item) => item.userId === participant.userId)) {
      recipients.push({
        userId: participant.userId,
        displayName: participant.displayName,
        confirmed: false,
        participationStatus: "invited",
        role: "member"
      });
    }
  }
  await appendForUsers(
    store,
    recipients,
    `两位创始成员已确认，活动清单正式发布。\n\n${formatEventPlan(plan, room)}`,
    `event-plan:${plan.planId}:published`,
    options.excludeUserId
  );
}

export async function notifyRoomUpdate(
  store: DataStore,
  room: MatchRoom,
  invite: MatchInvite,
  options: { excludeUserId?: string } = {}
): Promise<void> {
  if (invite.kind === "initial_pair" && room.eventPlans.draft) {
    await notifyEventPlanDraft(store, room, {
      reason: "created",
      excludeUserId: options.excludeUserId
    });
    return;
  }
  const joinedParticipant = invite.participants[0];
  const plan = room.eventPlans.published;
  const content = [
    `${joinedParticipant?.displayName ?? "新成员"} 已接受邀请并进入房间。`,
    `当前 ${room.members.length}/${room.capacity} 人。`,
    room.matchingStatus === "full"
      ? "房间已达到人数上限，匹配已自动停止。"
      : "系统会继续寻找下一位最合适的成员。",
    plan ? formatEventPlan(plan, room) : null
  ].filter(Boolean).join("\n\n");
  await appendForUsers(
    store,
    room.members,
    content,
    `room-update:${invite.inviteId}`,
    options.excludeUserId
  );
}

export async function notifyMatchInvite(
  store: DataStore,
  invite: MatchInvite,
  room: MatchRoom | null = null
): Promise<void> {
  await Promise.all(invite.participants.map(async (participant) => {
    const other = invite.participants.find((item) => item.userId !== participant.userId);
    const content = invite.kind === "initial_pair"
      ? [
          `我找到了当前与你最合适的匹配对象：${other?.displayName ?? "一位新朋友"}。`,
          `匹配考虑：${invite.matchSummary}`,
          "你们双方都接受后才会建立房间。回复“接受匹配”或“拒绝匹配”。"
        ].join("\n\n")
      : [
          `一个正在组建的房间向你发出了邀请，目前 ${room?.members.length ?? "若干"}/${room?.capacity ?? "上限"} 人。`,
          `匹配考虑：${invite.matchSummary}`,
          invite.eventPlan ? formatEventPlan(invite.eventPlan, room) : "活动清单暂不可用。",
          "回复“接受邀请”即可进入房间，或回复“拒绝邀请”。"
        ].join("\n\n");
    await store.appendProactiveMessage({
      userId: participant.userId,
      content,
      idempotencyKey: `match-invite:${invite.inviteId}:${participant.userId}`
    });
  }));
}
