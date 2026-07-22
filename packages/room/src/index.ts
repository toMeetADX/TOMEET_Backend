import type { MatchRoom } from "@tomeet/contracts";

export function assertCanConfirm(room: MatchRoom, userId: string): void {
  if (room.status === "completed") throw new Error("活动已结束，不能再次确认");
  if (!room.members.some((member) => member.userId === userId)) throw new Error("用户不在该房间中");
}

export function assertCanComplete(room: MatchRoom): void {
  if (room.status === "completed") return;
  if (!room.members.every((member) => member.confirmed)) throw new Error("所有成员确认后才能完成活动");
}
